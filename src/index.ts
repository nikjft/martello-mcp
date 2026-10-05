import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { TrelloClient } from "./trello-client.js";
import { McGawSemantics } from "./semantics.js";

import {
  computeCodeChallenge,
  exchangeAtlassianCode,
  generateCodeVerifier,
  refreshAtlassianToken,
  signState,
  StoredAuthCode,
  StoredSession,
  verifyPkce,
  verifyState
} from "./oauth.js";

export class MartelloMCP extends McpAgent {
  server = new McpServer({
    name: "mcgaw-trello-mcp",
    version: "1.0.0",
    description: "Martello MCP: McGaw Trello Project Management server running on Cloudflare Workers with OAuth 2.0"
  });

  private client!: TrelloClient;
  private semantics!: McGawSemantics;
  private workerEnv!: Env;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.workerEnv = env;
  }

  // --- RPC Methods for OAuth State & Session Management ---

  async storeAuthCode(data: StoredAuthCode): Promise<boolean> {
    await this.ctx.storage.put("code:" + data.code, data);
    return true;
  }

  async exchangeAuthCode(code: string, codeVerifier: string): Promise<any> {
    const stored = await this.ctx.storage.get<StoredAuthCode>("code:" + code);
    if (!stored) {
      return { status: 400, data: { error: "invalid_grant", error_description: "Authorization code not found or expired" } };
    }
    if (stored.expiresAt < Date.now()) {
      await this.ctx.storage.delete("code:" + code);
      return { status: 400, data: { error: "invalid_grant", error_description: "Authorization code expired" } };
    }

    const validPkce = await verifyPkce(codeVerifier, stored.codeChallenge, stored.codeChallengeMethod);
    if (!validPkce) {
      return { status: 400, data: { error: "invalid_grant", error_description: "PKCE verification failed" } };
    }

    await this.ctx.storage.delete("code:" + code);

    const mcpAccessToken = "mcp_at_" + crypto.randomUUID().replace(/-/g, "");
    const mcpRefreshToken = "mcp_rt_" + crypto.randomUUID().replace(/-/g, "");

    const session: StoredSession = {
      mcpAccessToken,
      mcpRefreshToken,
      atlassianAccessToken: stored.atlassianAccessToken,
      atlassianRefreshToken: stored.atlassianRefreshToken,
      expiresAt: Date.now() + 30 * 24 * 3600 * 1000,
      createdAt: Date.now()
    };

    await this.ctx.storage.put("session:" + mcpAccessToken, session);
    await this.ctx.storage.put("refresh:" + mcpRefreshToken, mcpAccessToken);

    return {
      status: 200,
      data: {
        access_token: mcpAccessToken,
        token_type: "Bearer",
        expires_in: 2592000,
        refresh_token: mcpRefreshToken
      }
    };
  }

  async refreshMcpSession(refreshToken: string, clientId?: string, clientSecret?: string): Promise<any> {
    const tokenKey = await this.ctx.storage.get<string>("refresh:" + refreshToken);
    if (!tokenKey) {
      return { status: 400, data: { error: "invalid_grant", error_description: "Invalid refresh token" } };
    }

    const session = await this.ctx.storage.get<StoredSession>("session:" + tokenKey);
    if (!session) {
      return { status: 400, data: { error: "invalid_grant", error_description: "Session not found" } };
    }

    if (session.atlassianRefreshToken && clientId && clientSecret) {
      try {
        const refreshed = await refreshAtlassianToken(clientId, clientSecret, session.atlassianRefreshToken);
        session.atlassianAccessToken = refreshed.access_token;
        if (refreshed.refresh_token) {
          session.atlassianRefreshToken = refreshed.refresh_token;
        }
      } catch (err) {
        console.warn("Failed to refresh Atlassian token:", err);
      }
    }

    const newAccessToken = "mcp_at_" + crypto.randomUUID().replace(/-/g, "");
    session.mcpAccessToken = newAccessToken;
    session.expiresAt = Date.now() + 30 * 24 * 3600 * 1000;

    await this.ctx.storage.delete("session:" + tokenKey);
    await this.ctx.storage.put("session:" + newAccessToken, session);
    await this.ctx.storage.put("refresh:" + refreshToken, newAccessToken);

    return {
      status: 200,
      data: {
        access_token: newAccessToken,
        token_type: "Bearer",
        expires_in: 2592000,
        refresh_token: refreshToken
      }
    };
  }

  async resolveSession(token: string, clientId?: string, clientSecret?: string): Promise<{ valid: boolean; trelloToken?: string }> {
    const session = await this.ctx.storage.get<StoredSession>("session:" + token);
    if (!session) {
      return { valid: false };
    }
    if (session.expiresAt < Date.now()) {
      await this.ctx.storage.delete("session:" + token);
      return { valid: false };
    }

    if (session.atlassianRefreshToken && clientId && clientSecret && session.expiresAt - Date.now() < 24 * 3600 * 1000) {
      try {
        const refreshed = await refreshAtlassianToken(clientId, clientSecret, session.atlassianRefreshToken);
        session.atlassianAccessToken = refreshed.access_token;
        if (refreshed.refresh_token) {
          session.atlassianRefreshToken = refreshed.refresh_token;
        }
        await this.ctx.storage.put("session:" + token, session);
      } catch {
        // Ignore refresh errors
      }
    }

    return {
      valid: true,
      trelloToken: session.atlassianAccessToken
    };
  }

  async init() {
    if (this.workerEnv?.TRELLO_API_KEY && this.workerEnv?.TRELLO_TOKEN) {
      this.client = new TrelloClient({
        apiKey: this.workerEnv.TRELLO_API_KEY,
        token: this.workerEnv.TRELLO_TOKEN,
      });
      this.semantics = new McGawSemantics(this.client);
    }

    const checkInit = () => {
      if (!this.client || (this.workerEnv?.TRELLO_TOKEN && (this.client as any).token !== this.workerEnv.TRELLO_TOKEN)) {
        if (this.workerEnv?.TRELLO_API_KEY && this.workerEnv?.TRELLO_TOKEN) {
          this.client = new TrelloClient({
            apiKey: this.workerEnv.TRELLO_API_KEY,
            token: this.workerEnv.TRELLO_TOKEN,
          });
          this.semantics = new McGawSemantics(this.client);
        } else {
          throw new Error("Trello client not initialized. Please connect via OAuth or configure credentials.");
        }
      }
    };

    // 1. search_cards
    this.server.tool(
      "search_cards",
      {
        query: z.string().describe("Trello search query (e.g., 'board:\"Board Name\" list:\"Next Week\"')."),
        excludeCompletedLists: z.boolean().optional().default(true).describe("Whether to manually exclude cards residing in lists that contain 'completed' in their name.")
      },
      async ({ query, excludeCompletedLists }) => {
        try {
          checkInit();
          const rawCards = await this.client.searchCards(query);
          let finalCards = rawCards;

          if (excludeCompletedLists) {
            const boardIds = [...new Set(rawCards.map(c => c.idBoard))];
            const listsMap = new Map<string, string>();
            for (const bid of boardIds) {
              const lists = await this.client.getBoardLists(bid);
              for (const l of lists) {
                listsMap.set(l.id, l.name.toLowerCase());
              }
            }
            finalCards = rawCards.filter(c => {
              const lname = listsMap.get(c.idList);
              if (!lname) return true;
              return !lname.includes("completed") && !lname.includes("template");
            });
          }

          const cardsWithMetadata = finalCards.map(c => ({
            ...c,
            isGroomed: this.semantics.isGroomed(c.name)
          }));

          return { content: [{ type: "text", text: JSON.stringify(cardsWithMetadata, null, 2) }] };
        } catch (error: any) {
          return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
        }
      }
    );

    // 2. query_boards
    this.server.tool(
      "query_boards",
      {
        nameFilter: z.string().optional().describe("Optional substring to filter board names.")
      },
      async ({ nameFilter }) => {
        try {
          checkInit();
          const boards = await this.client.getMyBoards();
          const filtered = nameFilter
            ? boards.filter(b => b.name.toLowerCase().includes(nameFilter.toLowerCase()))
            : boards;
          return { content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }] };
        } catch (error: any) {
          return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
        }
      }
    );

    // 3. get_board_lists
    this.server.tool(
      "get_board_lists",
      {
        boardId: z.string().describe("The Trello board ID.")
      },
      async ({ boardId }) => {
        try {
          checkInit();
          const lists = await this.client.getBoardLists(boardId);
          return { content: [{ type: "text", text: JSON.stringify(lists, null, 2) }] };
        } catch (error: any) {
          return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
        }
      }
    );

    // 4. query_epic_lineage
    this.server.tool(
      "query_epic_lineage",
      {
        epicCardUrlOrId: z.string().describe("The Trello card short URL or ID.")
      },
      async ({ epicCardUrlOrId }) => {
        try {
          checkInit();
          const lineage = await this.semantics.getEpicLineage(epicCardUrlOrId);
          return { content: [{ type: "text", text: JSON.stringify(lineage, null, 2) }] };
        } catch (error: any) {
          return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
        }
      }
    );

    // 5. create_card
    this.server.tool(
      "create_card",
      {
        listId: z.string().describe("The ID of the list to create the card in."),
        title: z.string().describe("Action-oriented title."),
        estimate: z.number().optional().describe("Estimated hours (optional). Will be prepended as (Est)."),
        description: z.string().optional().describe("Description containing Goal, Scope, and Result."),
        clientPrefix: z.string().optional().describe("Client prefix string for shared boards (e.g., 'Crunch Fitness: ')."),
        parentUrl: z.string().optional().describe("URL of the parent Epic or Sub-Epic to link to."),
        idMembers: z.array(z.string()).optional(),
        idLabels: z.array(z.string()).optional(),
        startDate: z.string().optional().describe("ISO date string for start date (Epics and Sub-Epics only)."),
        dueDate: z.string().optional().describe("ISO date string for due date.")
      },
      async ({
        listId,
        title,
        estimate,
        description,
        clientPrefix,
        parentUrl,
        idMembers,
        idLabels,
        startDate,
        dueDate
      }) => {
        try {
          checkInit();
          let finalTitle = title;
          if (clientPrefix) finalTitle = `${clientPrefix} ${finalTitle}`;
          if (estimate !== undefined) finalTitle = `(${estimate}) ${finalTitle}`;

          if (startDate && !this.semantics.isEpicOrSubEpic(finalTitle)) {
            throw new Error("Start dates can only be set on Epics or Sub-Epics. Tasks should only have a due date.");
          }

          const card = await this.client.createCard(listId, finalTitle, description, dueDate, startDate);
          if (idMembers || idLabels) {
            const updates: any = {};
            if (idMembers) updates.idMembers = idMembers.join(",");
            if (idLabels) updates.idLabels = idLabels.join(",");
            await this.client.updateCard(card.id, updates);
          }

          if (parentUrl) {
            const parentMatch = /https:\/\/trello\.com\/c\/([A-Za-z0-9]+)/i.exec(parentUrl);
            const parentId = parentMatch ? parentMatch[1] : parentUrl;
            const parentCard = await this.client.getCard(parentId);
            await this.semantics.updateRelationship(parentCard, card, "parent-child", "link");
          }

          return { content: [{ type: "text", text: JSON.stringify(card, null, 2) }] };
        } catch (error: any) {
          return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
        }
      }
    );

    // 6. update_card_details
    this.server.tool(
      "update_card_details",
      {
        cardId: z.string().describe("Trello card ID, Short Link, or URL."),
        title: z.string().optional(),
        description: z.string().optional(),
        dueDate: z.string().optional().describe("ISO date string to schedule the card (Trello due date)."),
        startDate: z.string().optional().describe("ISO date string for start date (Epics and Sub-Epics only)."),
        idMembers: z.array(z.string()).optional(),
        idLabels: z.array(z.string()).optional(),
        userNow: z.string().optional().describe("User's current ISO date string (for weekly list movement logic).")
      },
      async ({ cardId: rawId, title, description, dueDate, startDate, idMembers, idLabels, userNow }) => {
        try {
          checkInit();
          const cardId = this.semantics.extractCardId(rawId);
          const updates: any = {};
          if (title) updates.name = title;
          if (description) updates.desc = description;
          if (dueDate) updates.due = dueDate;
          if (startDate) updates.start = startDate;
          if (idMembers) updates.idMembers = idMembers.join(",");
          if (idLabels) updates.idLabels = idLabels.join(",");

          if (startDate) {
            const checkTitle = title || (await this.client.getCard(cardId)).name;
            if (!this.semantics.isEpicOrSubEpic(checkTitle)) {
              throw new Error("Start dates can only be set on Epics or Sub-Epics. Tasks should only have a due date.");
            }
          }

          if (dueDate && userNow) {
            const card = await this.client.getCard(cardId);
            const targetListId = await this.semantics.getTargetListForDate(
              card.idBoard,
              new Date(dueDate),
              new Date(userNow)
            );
            if (targetListId) {
              updates.idList = targetListId;
            }
          }

          const updated = await this.client.updateCard(cardId, updates);
          return { content: [{ type: "text", text: JSON.stringify(updated, null, 2) }] };
        } catch (error: any) {
          return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
        }
      }
    );

    // 7. update_estimate
    this.server.tool(
      "update_estimate",
      {
        cardId: z.string().describe("Trello card ID, Short Link, or URL."),
        newEstimate: z.number().describe("New estimated hours.")
      },
      async ({ cardId: rawId, newEstimate }) => {
        try {
          checkInit();
          const cardId = this.semantics.extractCardId(rawId);
          const card = await this.client.getCard(cardId);
          const newTitle = this.semantics.updateEstimate(card.name, newEstimate);
          const updated = await this.client.updateCard(card.id, { name: newTitle });
          return { content: [{ type: "text", text: JSON.stringify(updated, null, 2) }] };
        } catch (error: any) {
          return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
        }
      }
    );

    // 8. update_get_it_done_date
    this.server.tool(
      "update_get_it_done_date",
      {
        cardId: z.string().describe("Trello card ID, Short Link, or URL."),
        dateStr: z.string().describe("ISO date string.")
      },
      async ({ cardId: rawId, dateStr }) => {
        try {
          checkInit();
          const cardId = this.semantics.extractCardId(rawId);
          const card = await this.client.getCard(cardId);
          const customFieldId = await this.semantics.getItDoneDateFieldId(card.idBoard);
          if (!customFieldId) {
            throw new Error("Could not find 'Get it done Date' custom field on this board.");
          }
          await this.client.updateCustomField(cardId, customFieldId, { date: dateStr });
          return { content: [{ type: "text", text: "Successfully updated custom field." }] };
        } catch (error: any) {
          return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
        }
      }
    );

    // 9. move_card
    this.server.tool(
      "move_card",
      {
        cardId: z.string(),
        listId: z.string()
      },
      async ({ cardId: rawId, listId }) => {
        try {
          checkInit();
          const cardId = this.semantics.extractCardId(rawId);
          const updated = await this.client.updateCard(cardId, { idList: listId });
          return { content: [{ type: "text", text: JSON.stringify(updated, null, 2) }] };
        } catch (error: any) {
          return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
        }
      }
    );

    // 10. complete_card
    this.server.tool(
      "complete_card",
      {
        cardId: z.string().describe("Trello card ID, Short Link, or URL."),
        reviewListId: z.string().describe("ID of the Review list to move the card to.")
      },
      async ({ cardId: rawId, reviewListId }) => {
        try {
          checkInit();
          const cardId = this.semantics.extractCardId(rawId);
          const updated = await this.client.updateCard(cardId, { idList: reviewListId, dueComplete: true });
          return { content: [{ type: "text", text: JSON.stringify(updated, null, 2) }] };
        } catch (error: any) {
          return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
        }
      }
    );

    // 11. update_relationship
    this.server.tool(
      "update_relationship",
      {
        sourceCardId: z.string().describe("Trello card ID, Short Link, or URL."),
        targetCardId: z.string().describe("Trello card ID, Short Link, or URL."),
        relationshipType: z.enum(["parent-child", "blocker-blocked", "related"]),
        action: z.enum(["link", "unlink"])
      },
      async ({ sourceCardId: rawSource, targetCardId: rawTarget, relationshipType, action }) => {
        try {
          checkInit();
          const sourceId = this.semantics.extractCardId(rawSource);
          const targetId = this.semantics.extractCardId(rawTarget);
          const sourceCard = await this.client.getCard(sourceId);
          const targetCard = await this.client.getCard(targetId);
          await this.semantics.updateRelationship(sourceCard, targetCard, relationshipType, action);
          return { content: [{ type: "text", text: "Successfully updated relationship." }] };
        } catch (error: any) {
          return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
        }
      }
    );

    // 12. add_comment
    this.server.tool(
      "add_comment",
      {
        cardId: z.string().describe("Trello card ID, Short Link, or URL."),
        text: z.string()
      },
      async ({ cardId: rawId, text }) => {
        try {
          checkInit();
          const cardId = this.semantics.extractCardId(rawId);
          await this.client.addComment(cardId, text);
          return { content: [{ type: "text", text: "Comment added." }] };
        } catch (error: any) {
          return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
        }
      }
    );

    // 13. search_members
    this.server.tool(
      "search_members",
      {
        boardId: z.string(),
        query: z.string().describe("Name or username to search for.")
      },
      async ({ boardId, query }) => {
        try {
          checkInit();
          const members = await this.client.getBoardMembers(boardId);
          const q = query.toLowerCase();
          const filtered = members.filter((m: any) =>
            m.fullName?.toLowerCase().includes(q) ||
            m.username?.toLowerCase().includes(q)
          );
          return { content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }] };
        } catch (error: any) {
          return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
        }
      }
    );

    // 14. create_label
    this.server.tool(
      "create_label",
      {
        boardId: z.string(),
        name: z.string(),
        color: z.enum(["yellow", "purple", "blue", "red", "green", "orange", "black", "sky", "pink", "lime"])
      },
      async ({ boardId, name, color }) => {
        try {
          checkInit();
          const label = await this.client.createLabel(boardId, name, color);
          return { content: [{ type: "text", text: JSON.stringify(label, null, 2) }] };
        } catch (error: any) {
          return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
        }
      }
    );

    // 15. add_label_to_card
    this.server.tool(
      "add_label_to_card",
      {
        cardId: z.string().describe("Trello card ID, Short Link, or URL."),
        labelId: z.string().describe("The ID of the label to add.")
      },
      async ({ cardId: rawId, labelId }) => {
        try {
          checkInit();
          const cardId = this.semantics.extractCardId(rawId);
          await this.client.addLabelToCard(cardId, labelId);
          return { content: [{ type: "text", text: "Label added successfully." }] };
        } catch (error: any) {
          return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
        }
      }
    );

    // 16. remove_label_from_card
    this.server.tool(
      "remove_label_from_card",
      {
        cardId: z.string().describe("Trello card ID, Short Link, or URL."),
        labelId: z.string().describe("The ID of the label to remove.")
      },
      async ({ cardId: rawId, labelId }) => {
        try {
          checkInit();
          const cardId = this.semantics.extractCardId(rawId);
          await this.client.removeLabelFromCard(cardId, labelId);
          return { content: [{ type: "text", text: "Label removed successfully." }] };
        } catch (error: any) {
          return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
        }
      }
    );

    // 17. get_notifications (per trello-notifs scope-reduction logic)
    this.server.tool(
      "get_notifications",
      {
        lookback: z.enum(["unread", "7d", "14d", "30d", "all"]).optional().default("unread").describe("Lookback window: 'unread' (default, limits to unread notifications), '7d', '14d', '30d', or 'all'."),
        boardId: z.string().optional().describe("Optional board ID or name substring to filter notifications to a single board."),
        groupBy: z.enum(["card", "board", "flat"]).optional().default("card").describe("How to group results: 'card' (default, clusters all notifications by card), 'board' (groups by board), or 'flat' (list of individual notifications)."),
        includeCardDetails: z.boolean().optional().default(false).describe("If true, fetches full card details (list name, description, recent comments, assignees) for each card in the results."),
        includeAllTypes: z.boolean().optional().default(false).describe("If true, disables the trello-notifs scope reduction filter and returns all Trello notification types instead of only addedToCard, mentionedOnCard, and commentCard.")
      },
      async ({ lookback, boardId, groupBy, includeCardDetails, includeAllTypes }) => {
        try {
          checkInit();

          const days = lookback === "7d" ? 7 : lookback === "14d" ? 14 : lookback === "30d" ? 30 : null;
          const cutoff = days ? new Date(Date.now() - days * 86400 * 1000) : null;

          const [me, rawNotifs] = await Promise.all([
            this.client.getCurrentMember().catch(() => null),
            this.client.getNotifications({
              read_filter: (cutoff || lookback === "all") ? "all" : "unread",
              limit: (cutoff || lookback === "all") ? 1000 : 200
            })
          ]);

          const myId = me?.id;
          let filtered = rawNotifs.filter(n => {
            // Exclude self-actions
            if (myId && n.idMemberCreator === myId) return false;
            // Scope reduction noise filter per trello-notifs logic
            if (!includeAllTypes) {
              if (n.type !== "addedToCard" && n.type !== "mentionedOnCard" && n.type !== "commentCard") {
                return false;
              }
            }
            // Cutoff filter
            if (cutoff && new Date(n.date) < cutoff) return false;
            return true;
          });

          // Optional board filter
          if (boardId) {
            const bQuery = boardId.toLowerCase();
            filtered = filtered.filter(n =>
              n.data.board?.id === boardId ||
              (n.data.board?.name && n.data.board.name.toLowerCase().includes(bQuery))
            );
          }

          if (groupBy === "flat") {
            const output = {
              total: filtered.length,
              notifications: filtered.map(n => ({
                id: n.id,
                type: n.type,
                date: n.date,
                unread: n.unread,
                author: n.memberCreator?.fullName || n.memberCreator?.username || "Unknown",
                authorUsername: n.memberCreator?.username,
                board: n.data.board ? { id: n.data.board.id, name: n.data.board.name } : undefined,
                card: n.data.card ? { id: n.data.card.id, name: n.data.card.name, shortLink: n.data.card.shortLink } : undefined,
                snippet: n.data.text
              }))
            };
            return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }] };
          }

          if (groupBy === "board") {
            const boardGroups: Record<string, { boardId: string; boardName: string; count: number; cards: Record<string, any> }> = {};
            for (const n of filtered) {
              const bId = n.data.board?.id || "unknown";
              const bName = n.data.board?.name || "Unknown Board";
              if (!boardGroups[bId]) {
                boardGroups[bId] = { boardId: bId, boardName: bName, count: 0, cards: {} };
              }
              boardGroups[bId].count++;
              const cId = n.data.card?.id || "general";
              const cName = n.data.card?.name || "General / Board level notification";
              if (!boardGroups[bId].cards[cId]) {
                boardGroups[bId].cards[cId] = {
                  cardId: cId,
                  cardName: cName,
                  unreadCount: 0,
                  notificationIds: [],
                  latestDate: n.date,
                  items: []
                };
              }
              const cardEntry = boardGroups[bId].cards[cId];
              if (n.unread) cardEntry.unreadCount++;
              cardEntry.notificationIds.push(n.id);
              if (new Date(n.date) > new Date(cardEntry.latestDate)) {
                cardEntry.latestDate = n.date;
              }
              cardEntry.items.push({
                id: n.id,
                type: n.type,
                date: n.date,
                unread: n.unread,
                author: n.memberCreator?.fullName || n.memberCreator?.username || "Unknown",
                snippet: n.data.text
              });
            }

            const output = {
              totalNotifications: filtered.length,
              boards: Object.values(boardGroups).map(b => ({
                ...b,
                cards: Object.values(b.cards).sort((x, y) => new Date(y.latestDate).getTime() - new Date(x.latestDate).getTime())
              }))
            };
            return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }] };
          }

          // Default: groupBy === "card"
          const cardMap = new Map<string, {
            cardId: string;
            cardName: string;
            boardId?: string;
            boardName?: string;
            unreadCount: number;
            notificationIds: string[];
            latestDate: string;
            items: any[];
            cardDetail?: any;
          }>();

          for (const n of filtered) {
            const cardId = n.data.card?.id || "general";
            const cardName = n.data.card?.name || "General / Non-card notification";
            if (!cardMap.has(cardId)) {
              cardMap.set(cardId, {
                cardId,
                cardName,
                boardId: n.data.board?.id,
                boardName: n.data.board?.name,
                unreadCount: 0,
                notificationIds: [],
                latestDate: n.date,
                items: []
              });
            }
            const group = cardMap.get(cardId)!;
            if (n.unread) group.unreadCount++;
            group.notificationIds.push(n.id);
            if (new Date(n.date) > new Date(group.latestDate)) {
              group.latestDate = n.date;
            }
            group.items.push({
              id: n.id,
              type: n.type,
              date: n.date,
              unread: n.unread,
              author: n.memberCreator?.fullName || n.memberCreator?.username || "Unknown",
              authorUsername: n.memberCreator?.username,
              snippet: n.data.text
            });
          }

          const cards = Array.from(cardMap.values()).sort(
            (a, b) => new Date(b.latestDate).getTime() - new Date(a.latestDate).getTime()
          );

          if (includeCardDetails) {
            for (const c of cards) {
              if (c.cardId && c.cardId !== "general") {
                try {
                  c.cardDetail = await this.client.getCardDetail(c.cardId);
                } catch {}
              }
            }
          }

          const output = {
            totalNotifications: filtered.length,
            totalCards: cards.length,
            cards
          };
          return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }] };
        } catch (error: any) {
          return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
        }
      }
    );

    // 18. get_notification_card_detail
    this.server.tool(
      "get_notification_card_detail",
      {
        cardId: z.string().describe("Trello card ID, Short Link, or URL.")
      },
      async ({ cardId: rawId }) => {
        try {
          checkInit();
          const cardId = this.semantics.extractCardId(rawId);

          const [cardDetail, unreadNotifs] = await Promise.all([
            this.client.getCardDetail(cardId),
            this.client.getNotifications({ read_filter: "unread", limit: 200 }).catch(() => [])
          ]);

          const cardNotifs = unreadNotifs.filter(n =>
            n.data.card?.id === cardId ||
            (n.data.card?.shortLink && rawId.includes(n.data.card.shortLink))
          );

          cardDetail.associatedNotificationIds = cardNotifs.map(n => n.id);

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                card: cardDetail,
                unreadNotificationCount: cardNotifs.length,
                associatedNotificationIds: cardDetail.associatedNotificationIds
              }, null, 2)
            }]
          };
        } catch (error: any) {
          return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
        }
      }
    );

    // 19. mark_notifications_read
    this.server.tool(
      "mark_notifications_read",
      {
        notificationIds: z.array(z.string()).optional().describe("Specific notification IDs to mark as read."),
        cardId: z.string().optional().describe("Trello card ID or Short Link. Marks all unread notifications for this card as read."),
        boardId: z.string().optional().describe("Trello board ID. Marks all unread notifications for this board as read."),
        allUnread: z.boolean().optional().describe("If true, marks all currently unread actionable notifications as read.")
      },
      async ({ notificationIds, cardId: rawCardId, boardId, allUnread }) => {
        try {
          checkInit();
          const idsToMark = new Set<string>(notificationIds || []);

          if (rawCardId || boardId || allUnread) {
            const resolvedCardId = rawCardId ? this.semantics.extractCardId(rawCardId) : null;
            const unread = await this.client.getNotifications({ read_filter: "unread", limit: 500 });
            for (const n of unread) {
              if (resolvedCardId && (n.data.card?.id === resolvedCardId || (n.data.card?.shortLink && rawCardId?.includes(n.data.card.shortLink)))) {
                idsToMark.add(n.id);
              }
              if (boardId && n.data.board?.id === boardId) {
                idsToMark.add(n.id);
              }
              if (allUnread) {
                if (n.type === "addedToCard" || n.type === "mentionedOnCard" || n.type === "commentCard") {
                  idsToMark.add(n.id);
                }
              }
            }
          }

          if (idsToMark.size === 0) {
            return { content: [{ type: "text", text: "No matching unread notifications found to mark as read." }] };
          }

          const idList = Array.from(idsToMark);
          await Promise.all(idList.map(id => this.client.markNotificationRead(id)));

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: true,
                markedReadCount: idList.length,
                markedNotificationIds: idList
              }, null, 2)
            }]
          };
        } catch (error: any) {
          return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
        }
      }
    );

    // 20. reply_to_notification
    this.server.tool(
      "reply_to_notification",
      {
        cardId: z.string().describe("Trello card ID, Short Link, or URL to post comment on."),
        text: z.string().describe("Comment text to post on the card."),
        markRead: z.boolean().optional().default(true).describe("Whether to automatically mark the card's notifications as read after posting the comment.")
      },
      async ({ cardId: rawId, text, markRead }) => {
        try {
          checkInit();
          const cardId = this.semantics.extractCardId(rawId);
          await this.client.addComment(cardId, text);

          let markedCount = 0;
          if (markRead) {
            const unread = await this.client.getNotifications({ read_filter: "unread", limit: 200 }).catch(() => []);
            const matchingIds = unread
              .filter(n => n.data.card?.id === cardId || (n.data.card?.shortLink && rawId.includes(n.data.card.shortLink)))
              .map(n => n.id);
            if (matchingIds.length > 0) {
              await Promise.all(matchingIds.map(id => this.client.markNotificationRead(id)));
              markedCount = matchingIds.length;
            }
          }

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: true,
                cardId,
                commentPosted: text,
                markedNotificationsRead: markedCount
              }, null, 2)
            }]
          };
        } catch (error: any) {
          return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
        }
      }
    );
  }
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, HEAD",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, mcp-session-id, mcp-protocol-version, x-requested-with, x-admin-auth",
  "Access-Control-Expose-Headers": "mcp-session-id, WWW-Authenticate, Authorization"
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // 0. Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // 1a. RFC 9728 Protected Resource Metadata
    if (
      url.pathname === "/.well-known/oauth-protected-resource" ||
      url.pathname.startsWith("/.well-known/oauth-protected-resource/") ||
      url.pathname.endsWith("/.well-known/oauth-protected-resource")
    ) {
      const resource = url.origin;
      return Response.json(
        {
          resource,
          authorization_servers: [url.origin],
          scopes_supported: [],
          bearer_methods_supported: ["header"]
        },
        {
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "application/json"
          }
        }
      );
    }

    // 1b. RFC 8414 OAuth 2.0 Authorization Server Metadata
    if (url.pathname === "/.well-known/oauth-authorization-server" || url.pathname === "/.well-known/openid-configuration") {
      const metadata = {
        issuer: url.origin,
        authorization_endpoint: `${url.origin}/oauth/authorize`,
        token_endpoint: `${url.origin}/oauth/token`,
        registration_endpoint: `${url.origin}/oauth/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"]
      };
      return Response.json(metadata, {
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/json"
        }
      });
    }

    // 1c. RFC 7591 Dynamic Client Registration (/oauth/register)
    if (url.pathname === "/oauth/register") {
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405, headers: CORS_HEADERS });
      }

      let body: any = {};
      try {
        body = await request.json();
      } catch {
        body = {};
      }

      const clientId = "client_" + crypto.randomUUID().replace(/-/g, "");
      const clientSecret = "cs_" + crypto.randomUUID().replace(/-/g, "");

      const registrationResponse = {
        client_id: clientId,
        client_secret: clientSecret,
        client_name: body.client_name || "Claude",
        redirect_uris: body.redirect_uris || [
          "https://claude.ai/api/mcp/auth_callback",
          "https://claude.ai/api/mcp/oauth_callback"
        ],
        grant_types: body.grant_types || ["authorization_code", "refresh_token"],
        response_types: body.response_types || ["code"],
        token_endpoint_auth_method: body.token_endpoint_auth_method || "none"
      };

      return Response.json(registrationResponse, {
        status: 201,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/json"
        }
      });
    }

    // 2. OAuth 2.0 Authorization Endpoint (/oauth/authorize)
    if (url.pathname === "/oauth/authorize") {
      const clientId = url.searchParams.get("client_id") || "claude";
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state") || "";
      const codeChallenge = url.searchParams.get("code_challenge");
      const codeChallengeMethod = url.searchParams.get("code_challenge_method") || "S256";

      if (!redirectUri || !codeChallenge) {
        return new Response("Missing redirect_uri or code_challenge parameter", { status: 400 });
      }

      // If Atlassian OAuth credentials configured: Use Atlassian OAuth 2.0 (3LO)
      if (env.TRELLO_CLIENT_ID && env.TRELLO_CLIENT_SECRET) {
        const atlassianVerifier = generateCodeVerifier();
        const atlassianChallenge = await computeCodeChallenge(atlassianVerifier);

        const signedState = await signState(
          {
            redirectUri,
            clientState: state,
            codeChallenge,
            codeChallengeMethod,
            clientId,
            atlassianCodeVerifier: atlassianVerifier,
            timestamp: Date.now()
          },
          env.TRELLO_CLIENT_SECRET
        );

        const atlassianAuthUrl = new URL("https://auth.atlassian.com/authorize");
        atlassianAuthUrl.searchParams.set("audience", "api.atlassian.com");
        atlassianAuthUrl.searchParams.set("client_id", env.TRELLO_CLIENT_ID);
        atlassianAuthUrl.searchParams.set(
          "scope",
          "read:board:trello write:board:trello read:member:trello write:card:trello offline_access"
        );
        atlassianAuthUrl.searchParams.set("redirect_uri", `${url.origin}/oauth/callback`);
        atlassianAuthUrl.searchParams.set("state", signedState);
        atlassianAuthUrl.searchParams.set("response_type", "code");
        atlassianAuthUrl.searchParams.set("prompt", "consent");
        atlassianAuthUrl.searchParams.set("code_challenge", atlassianChallenge);
        atlassianAuthUrl.searchParams.set("code_challenge_method", "S256");

        return Response.redirect(atlassianAuthUrl.toString(), 302);
      }

      // Fallback: Trello Native Token Authorization
      if (!env.TRELLO_API_KEY) {
        return new Response("Server configuration error: TRELLO_API_KEY missing", { status: 500 });
      }

      const trelloAuthUrl = new URL("https://trello.com/1/authorize");
      trelloAuthUrl.searchParams.set("key", env.TRELLO_API_KEY);
      trelloAuthUrl.searchParams.set("name", "Martello MCP");
      trelloAuthUrl.searchParams.set("response_type", "token");
      trelloAuthUrl.searchParams.set("scope", "read,write");
      trelloAuthUrl.searchParams.set("expiration", "never");
      trelloAuthUrl.searchParams.set("return_url", `${url.origin}/oauth/callback`);

      return Response.redirect(trelloAuthUrl.toString(), 302);
    }

    // 3. Upstream Atlassian OAuth Callback (/oauth/callback)
    if (url.pathname === "/oauth/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");

      if (!code || !state) {
        return new Response("Invalid Atlassian OAuth callback: missing code or state", { status: 400 });
      }

      if (!env.TRELLO_CLIENT_SECRET || !env.TRELLO_CLIENT_ID) {
        return new Response("Server error: TRELLO_CLIENT_ID or TRELLO_CLIENT_SECRET not configured", { status: 500 });
      }

      const verifiedState = await verifyState(state, env.TRELLO_CLIENT_SECRET);
      if (!verifiedState) {
        return new Response("Invalid or expired OAuth state parameter. Please try logging in again.", { status: 400 });
      }

      try {
        const tokens = await exchangeAtlassianCode(
          env.TRELLO_CLIENT_ID,
          env.TRELLO_CLIENT_SECRET,
          code,
          `${url.origin}/oauth/callback`,
          verifiedState.atlassianCodeVerifier
        );

        const authCode = crypto.randomUUID();
        const stub = env.MCP_OBJECT.get(env.MCP_OBJECT.idFromName("oauth-storage"));

        await (stub as any).storeAuthCode({
          code: authCode,
          codeChallenge: verifiedState.codeChallenge,
          codeChallengeMethod: verifiedState.codeChallengeMethod,
          atlassianAccessToken: tokens.access_token,
          atlassianRefreshToken: tokens.refresh_token,
          expiresAt: Date.now() + 10 * 60 * 1000
        } as StoredAuthCode);

        const returnUrl = new URL(verifiedState.redirectUri);
        returnUrl.searchParams.set("code", authCode);
        if (verifiedState.clientState) {
          returnUrl.searchParams.set("state", verifiedState.clientState);
        }

        return Response.redirect(returnUrl.toString(), 302);
      } catch (err: any) {
        return new Response(`Atlassian OAuth Error: ${err.message}`, { status: 500 });
      }
    }

    // 4. OAuth 2.0 Token Endpoint (/oauth/token)
    if (url.pathname === "/oauth/token") {
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405 });
      }

      let params: Record<string, string> = {};
      const contentType = request.headers.get("content-type") || "";
      if (contentType.includes("application/x-www-form-urlencoded")) {
        const text = await request.text();
        const search = new URLSearchParams(text);
        for (const [k, v] of search.entries()) {
          params[k] = v;
        }
      } else {
        try {
          params = await request.json();
        } catch {
          params = {};
        }
      }

      const grantType = params.grant_type;
      const stub = env.MCP_OBJECT.get(env.MCP_OBJECT.idFromName("oauth-storage"));

      if (grantType === "authorization_code") {
        const code = params.code;
        const codeVerifier = params.code_verifier;
        if (!code || !codeVerifier) {
          return Response.json(
            { error: "invalid_request", error_description: "Missing code or code_verifier" },
            { status: 400, headers: CORS_HEADERS }
          );
        }

        const res = await (stub as any).exchangeAuthCode(code, codeVerifier);
        return Response.json(res.data, { status: res.status, headers: CORS_HEADERS });
      }

      if (grantType === "refresh_token") {
        const refreshToken = params.refresh_token;
        if (!refreshToken) {
          return Response.json(
            { error: "invalid_request", error_description: "Missing refresh_token" },
            { status: 400, headers: CORS_HEADERS }
          );
        }

        const res = await (stub as any).refreshMcpSession(
          refreshToken,
          env.TRELLO_CLIENT_ID,
          env.TRELLO_CLIENT_SECRET
        );
        return Response.json(res.data, { status: res.status, headers: CORS_HEADERS });
      }

      return Response.json(
        { error: "unsupported_grant_type", error_description: "Supported: authorization_code, refresh_token" },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    // 5. MCP Transport Endpoints (/sse, /sse/message, /mcp, or root MCP probe)
    const isMcpPath = url.pathname === "/sse" || url.pathname === "/sse/message" || url.pathname === "/mcp";
    const isRootMcpProbe = url.pathname === "/" && !request.headers.get("Accept")?.includes("text/html");

    if (isMcpPath || isRootMcpProbe) {
      let activeTrelloToken = "";

      const authHeader = request.headers.get("Authorization");
      if (authHeader?.startsWith("Bearer ")) {
        const token = authHeader.slice(7).trim();
        const stub = env.MCP_OBJECT.get(env.MCP_OBJECT.idFromName("oauth-storage"));

        const res = await (stub as any).resolveSession(
          token,
          env.TRELLO_CLIENT_ID,
          env.TRELLO_CLIENT_SECRET
        );
        if (res?.valid && res.trelloToken) {
          activeTrelloToken = res.trelloToken;
        }
      }

      // Allow fallback PAT if explicitly requested (?auth=admin or X-Admin-Auth)
      const allowPat = request.headers.get("X-Admin-Auth") === "true" || url.searchParams.get("auth") === "admin";
      if (!activeTrelloToken && allowPat && env.TRELLO_TOKEN) {
        activeTrelloToken = env.TRELLO_TOKEN;
      }

      // If no valid session: Challenge client with RFC 9728 401 WWW-Authenticate
      if (!activeTrelloToken) {
        return new Response(
          JSON.stringify({
            error: "unauthorized",
            message: "Authentication required. Please connect via OAuth 2.0."
          }),
          {
            status: 401,
            headers: {
              ...CORS_HEADERS,
              "Content-Type": "application/json",
              "WWW-Authenticate": `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource"`
            }
          }
        );
      }

      // Provide scoped env with the active user's Trello token
      const scopedEnv: Env = {
        ...env,
        TRELLO_TOKEN: activeTrelloToken
      };

      if (url.pathname === "/mcp" || (isRootMcpProbe && request.method === "POST")) {
        return MartelloMCP.serve("/mcp", { corsOptions: { origin: "*" } }).fetch(request, scopedEnv, ctx);
      }

      return MartelloMCP.serveSSE("/sse", { corsOptions: { origin: "*" } }).fetch(request, scopedEnv, ctx);
    }

    // Default root welcome / diagnostic info
    return new Response(
      `Martello MCP Server (Cloudflare Worker with OAuth 2.0)
Available endpoints:
  - SSE MCP: /sse
  - Streamable MCP: /mcp
  - OAuth Discovery: /.well-known/oauth-authorization-server
  - OAuth Protected Resource: /.well-known/oauth-protected-resource
  - OAuth Authorize: /oauth/authorize
  - OAuth Token: /oauth/token`,
      {
        status: 200,
        headers: { "Content-Type": "text/plain" }
      }
    );
  }
};

