import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { TrelloClient } from "./trello-client.js";
import { McGawSemantics } from "./semantics.js";

export class MartelloMCP extends McpAgent {
  server = new McpServer({
    name: "mcgaw-trello-mcp",
    version: "1.0.0",
    description: "Martello MCP: McGaw Trello Project Management server running on Cloudflare Workers"
  });

  private client!: TrelloClient;
  private semantics!: McGawSemantics;
  private workerEnv!: Env;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.workerEnv = env;
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
      if (!this.client || !this.semantics) {
        throw new Error(
          "Trello client not initialized. Please ensure TRELLO_API_KEY and TRELLO_TOKEN secrets are configured."
        );
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
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/sse" || url.pathname === "/sse/message") {
      return MartelloMCP.serveSSE("/sse").fetch(request, env, ctx);
    }

    if (url.pathname === "/mcp") {
      return MartelloMCP.serve("/mcp").fetch(request, env, ctx);
    }

    return new Response(
      "Martello MCP Server (Cloudflare Worker) - Available endpoints: /sse, /mcp",
      {
        status: 200,
        headers: { "Content-Type": "text/plain" }
      }
    );
  }
};
