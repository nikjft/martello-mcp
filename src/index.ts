import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { TrelloClient } from './trello-client.js';
import { McGawSemantics } from './semantics.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Manually load .env.local to avoid dotenvx noise on stdout
try {
  const envPath = path.resolve(process.cwd(), '.env.local');
  if (fs.existsSync(envPath)) {
    const envConfig = fs.readFileSync(envPath, 'utf-8');
    envConfig.split('\n').forEach((line: string) => {
      const [key, ...valueParts] = line.split('=');
      if (key && valueParts.length > 0) {
        process.env[key.trim()] = valueParts.join('=').trim();
      }
    });
  }
} catch (e) {
  // Ignore
}

const API_KEY = process.env.TRELLO_API_KEY;
const TOKEN = process.env.TRELLO_TOKEN;

if (!API_KEY || !TOKEN) {
  console.error("TRELLO_API_KEY and TRELLO_TOKEN environment variables must be set.");
  process.exit(1);
}

const client = new TrelloClient({ apiKey: API_KEY, token: TOKEN });
const semantics = new McGawSemantics(client);

const server = new Server({
  name: "mcgaw-trello-mcp",
  version: "1.0.0"
}, {
  capabilities: {
    tools: {}
  }
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "search_cards",
        description: "Search for cards across boards using Trello's advanced search syntax. Automatically filters out cards in 'Completed*' lists unless 'is:archived' or similar is explicitly requested.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Trello search query (e.g., 'board:\"Board Name\" list:\"Next Week\"')." },
            excludeCompletedLists: { type: "boolean", description: "Whether to manually exclude cards residing in lists that contain 'completed' in their name.", default: true }
          },
          required: ["query"]
        }
      },
      {
        name: "query_boards",
        description: "List all open boards or search by name.",
        inputSchema: {
          type: "object",
          properties: {
            nameFilter: { type: "string", description: "Optional substring to filter board names." }
          }
        }
      },
      {
        name: "get_board_lists",
        description: "Get all lists on a specific Trello board.",
        inputSchema: {
          type: "object",
          properties: {
            boardId: { type: "string", description: "The Trello board ID." }
          },
          required: ["boardId"]
        }
      },
      {
        name: "query_epic_lineage",
        description: "Get the full tree/lineage of an Epic or Sub-Epic by following the 'children' checklists recursively.",
        inputSchema: {
          type: "object",
          properties: {
            epicCardUrlOrId: { type: "string", description: "The Trello card short URL or ID." }
          },
          required: ["epicCardUrlOrId"]
        }
      },
      {
        name: "create_card",
        description: "Create a new task card. Enforces estimate formatting if provided. Automatically cascades Epic labels if parentUrl is provided.",
        inputSchema: {
          type: "object",
          properties: {
            listId: { type: "string", description: "The ID of the list to create the card in." },
            title: { type: "string", description: "Action-oriented title." },
            estimate: { type: "number", description: "Estimated hours (optional). Will be prepended as (Est)." },
            description: { type: "string", description: "Description containing Goal, Scope, and Result." },
            clientPrefix: { type: "string", description: "Client prefix string for shared boards (e.g., 'Crunch Fitness: ')." },
            parentUrl: { type: "string", description: "URL of the parent Epic or Sub-Epic to link to." },
            idMembers: { type: "array", items: { type: "string" } },
            idLabels: { type: "array", items: { type: "string" } },
            startDate: { type: "string", description: "ISO date string for start date (Epics and Sub-Epics only)." },
            dueDate: { type: "string", description: "ISO date string for due date." }
          },
          required: ["listId", "title"]
        }
      },
      {
        name: "update_card_details",
        description: "Update the title, description, or schedule (due and start dates) of a card.",
        inputSchema: {
          type: "object",
          properties: {
            cardId: { type: "string", description: "Trello card ID, Short Link, or URL." },
            title: { type: "string" },
            description: { type: "string" },
            dueDate: { type: "string", description: "ISO date string to schedule the card (Trello due date)." },
            startDate: { type: "string", description: "ISO date string for start date (Epics and Sub-Epics only)." },
            idMembers: { type: "array", items: { type: "string" } },
            idLabels: { type: "array", items: { type: "string" } },
            userNow: { type: "string", description: "User's current ISO date string (for weekly list movement logic)." }
          },
          required: ["cardId"]
        }
      },
      {
        name: "update_estimate",
        description: "Safely update the (Est) portion of a card title without touching the [Spent] portion.",
        inputSchema: {
          type: "object",
          properties: {
            cardId: { type: "string", description: "Trello card ID, Short Link, or URL." },
            newEstimate: { type: "number", description: "New estimated hours." }
          },
          required: ["cardId", "newEstimate"]
        }
      },
      {
        name: "update_get_it_done_date",
        description: "Update the 'Get it done Date' custom field. Looks up the field dynamically by name for the board.",
        inputSchema: {
          type: "object",
          properties: {
            cardId: { type: "string", description: "Trello card ID, Short Link, or URL." },
            dateStr: { type: "string", description: "ISO date string." }
          },
          required: ["cardId", "dateStr"]
        }
      },
      {
        name: "move_card",
        description: "Move a card to a different list.",
        inputSchema: {
          type: "object",
          properties: {
            cardId: { type: "string" },
            listId: { type: "string" }
          },
          required: ["cardId", "listId"]
        }
      },
      {
        name: "complete_card",
        description: "Semantically complete a card: Marks due date complete, and moves it to a 'Review' list.",
        inputSchema: {
          type: "object",
          properties: {
            cardId: { type: "string", description: "Trello card ID, Short Link, or URL." },
            reviewListId: { type: "string", description: "ID of the Review list to move the card to." }
          },
          required: ["cardId", "reviewListId"]
        }
      },
      {
        name: "update_relationship",
        description: "Establish or remove a bidirectional relationship between two cards.",
        inputSchema: {
          type: "object",
          properties: {
            sourceCardId: { type: "string", description: "Trello card ID, Short Link, or URL." },
            targetCardId: { type: "string", description: "Trello card ID, Short Link, or URL." },
            relationshipType: { type: "string", enum: ["parent-child", "blocker-blocked", "related"] },
            action: { type: "string", enum: ["link", "unlink"] }
          },
          required: ["sourceCardId", "targetCardId", "relationshipType", "action"]
        }
      },
      {
        name: "add_comment",
        description: "Add a comment to a card. Can include @mentions.",
        inputSchema: {
          type: "object",
          properties: {
            cardId: { type: "string", description: "Trello card ID, Short Link, or URL." },
            text: { type: "string" }
          },
          required: ["cardId", "text"]
        }
      },
      {
        name: "search_members",
        description: "Search for members on a board by name or username to get their Trello IDs.",
        inputSchema: {
          type: "object",
          properties: {
            boardId: { type: "string" },
            query: { type: "string", description: "Name or username to search for." }
          },
          required: ["boardId", "query"]
        }
      },
      {
        name: "create_label",
        description: "Create a new label on a board.",
        inputSchema: {
          type: "object",
          properties: {
            boardId: { type: "string" },
            name: { type: "string" },
            color: { type: "string", enum: ["yellow", "purple", "blue", "red", "green", "orange", "black", "sky", "pink", "lime"] }
          },
          required: ["boardId", "name", "color"]
        }
      },
      {
        name: "add_label_to_card",
        description: "Add an existing label to a card.",
        inputSchema: {
          type: "object",
          properties: {
            cardId: { type: "string", description: "Trello card ID, Short Link, or URL." },
            labelId: { type: "string", description: "The ID of the label to add." }
          },
          required: ["cardId", "labelId"]
        }
      },
      {
        name: "remove_label_from_card",
        description: "Remove a label from a card.",
        inputSchema: {
          type: "object",
          properties: {
            cardId: { type: "string", description: "Trello card ID, Short Link, or URL." },
            labelId: { type: "string", description: "The ID of the label to remove." }
          },
          required: ["cardId", "labelId"]
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    switch (name) {
      case "search_cards": {
        const { query, excludeCompletedLists = true } = args as any;
        const rawCards = await client.searchCards(query);
        let finalCards = rawCards;

        if (excludeCompletedLists) {
          // Resolve list names to filter out "completed" lists
          // To do this efficiently, we gather unique board IDs and fetch their lists
          const boardIds = [...new Set(rawCards.map(c => c.idBoard))];
          const listsMap = new Map<string, string>(); // listId -> listName
          for (const bid of boardIds) {
            const lists = await client.getBoardLists(bid);
            for (const l of lists) {
              listsMap.set(l.id, l.name.toLowerCase());
            }
          }
          finalCards = rawCards.filter(c => {
            const lname = listsMap.get(c.idList);
            if (!lname) return true;
            const matchesCompleted = lname.includes("completed") || lname.includes("template");
            // Also check for ungroomed cards if they are in these lists? 
            // Actually, usually we exclude completed lists entirely.
            return !matchesCompleted;
          });
        }
        
        // Add groomed flag to results
        const cardsWithMetadata = finalCards.map(c => ({
          ...c,
          isGroomed: semantics.isGroomed(c.name)
        }));
        
        return { content: [{ type: "text", text: JSON.stringify(cardsWithMetadata, null, 2) }] };
      }

      case "query_boards": {
        const { nameFilter } = args as any;
        const boards = await client.getMyBoards();
        const filtered = nameFilter ? boards.filter(b => b.name.toLowerCase().includes(nameFilter.toLowerCase())) : boards;
        return { content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }] };
      }

      case "get_board_lists": {
        const { boardId } = args as any;
        const lists = await client.getBoardLists(boardId);
        return { content: [{ type: "text", text: JSON.stringify(lists, null, 2) }] };
      }

      case "query_epic_lineage": {
        const { epicCardUrlOrId } = args as any;
        const lineage = await semantics.getEpicLineage(epicCardUrlOrId);
        return { content: [{ type: "text", text: JSON.stringify(lineage, null, 2) }] };
      }

      case "create_card": {
        const { listId, title, estimate, description, clientPrefix, parentUrl, idMembers, idLabels, startDate, dueDate } = args as any;
        let finalTitle = title;
        if (clientPrefix) finalTitle = `${clientPrefix} ${finalTitle}`;
        if (estimate !== undefined) finalTitle = `(${estimate}) ${finalTitle}`;

        // Enforcement: startDate only for Epics/Sub-Epics
        if (startDate && !semantics.isEpicOrSubEpic(finalTitle)) {
          throw new Error("Start dates can only be set on Epics or Sub-Epics. Tasks should only have a due date.");
        }

        const card = await client.createCard(listId, finalTitle, description, dueDate, startDate);
        if (idMembers || idLabels) {
          const updates: any = {};
          if (idMembers) updates.idMembers = idMembers.join(',');
          if (idLabels) updates.idLabels = idLabels.join(',');
          await client.updateCard(card.id, updates);
        }

        if (parentUrl) {
          const parentMatch = /https:\/\/trello\.com\/c\/([A-Za-z0-9]+)/i.exec(parentUrl);
          const parentId = parentMatch ? parentMatch[1] : parentUrl;
          const parentCard = await client.getCard(parentId);
          await semantics.updateRelationship(parentCard, card, "parent-child", "link");
        }

        return { content: [{ type: "text", text: JSON.stringify(card, null, 2) }] };
      }

      case "update_card_details": {
        const { cardId: rawId, title, description, dueDate, startDate, idMembers, idLabels, userNow } = args as any;
        const cardId = semantics.extractCardId(rawId);
        const updates: any = {};
        if (title) updates.name = title;
        if (description) updates.desc = description;
        if (dueDate) updates.due = dueDate;
        if (startDate) updates.start = startDate;
        if (idMembers) updates.idMembers = idMembers.join(',');
        if (idLabels) updates.idLabels = idLabels.join(',');

        // Enforcement: startDate only for Epics/Sub-Epics
        if (startDate) {
          // If title is changing, check the new title. Otherwise, fetch the card to check existing title.
          const checkTitle = title || (await client.getCard(cardId)).name;
          if (!semantics.isEpicOrSubEpic(checkTitle)) {
            throw new Error("Start dates can only be set on Epics or Sub-Epics. Tasks should only have a due date.");
          }
        }
        
        // If due date changed, calculate target list
        if (dueDate && userNow) {
          const card = await client.getCard(cardId);
          const targetListId = await semantics.getTargetListForDate(card.idBoard, new Date(dueDate), new Date(userNow));
          if (targetListId) {
            updates.idList = targetListId;
          }
        }
        
        const updated = await client.updateCard(cardId, updates);
        return { content: [{ type: "text", text: JSON.stringify(updated, null, 2) }] };
      }

      case "update_estimate": {
        const { cardId: rawId, newEstimate } = args as any;
        const cardId = semantics.extractCardId(rawId);
        const card = await client.getCard(cardId);
        const newTitle = semantics.updateEstimate(card.name, newEstimate);
        const updated = await client.updateCard(card.id, { name: newTitle });
        return { content: [{ type: "text", text: JSON.stringify(updated, null, 2) }] };
      }

      case "update_get_it_done_date": {
        const { cardId: rawId, dateStr } = args as any;
        const cardId = semantics.extractCardId(rawId);
        const card = await client.getCard(cardId);
        const customFieldId = await semantics.getItDoneDateFieldId(card.idBoard);
        if (!customFieldId) {
          throw new Error("Could not find 'Get it done Date' custom field on this board.");
        }
        await client.updateCustomField(cardId, customFieldId, { date: dateStr });
        return { content: [{ type: "text", text: "Successfully updated custom field." }] };
      }

      case "move_card": {
        const { cardId: rawId, listId } = args as any;
        const cardId = semantics.extractCardId(rawId);
        const updated = await client.updateCard(cardId, { idList: listId });
        return { content: [{ type: "text", text: JSON.stringify(updated, null, 2) }] };
      }

      case "complete_card": {
        const { cardId: rawId, reviewListId } = args as any;
        const cardId = semantics.extractCardId(rawId);
        const updated = await client.updateCard(cardId, { idList: reviewListId, dueComplete: true });
        return { content: [{ type: "text", text: JSON.stringify(updated, null, 2) }] };
      }

      case "update_relationship": {
        const { sourceCardId: rawSource, targetCardId: rawTarget, relationshipType, action } = args as any;
        const sourceId = semantics.extractCardId(rawSource);
        const targetId = semantics.extractCardId(rawTarget);
        const sourceCard = await client.getCard(sourceId);
        const targetCard = await client.getCard(targetId);
        await semantics.updateRelationship(sourceCard, targetCard, relationshipType as any, action as any);
        return { content: [{ type: "text", text: "Successfully updated relationship." }] };
      }

      case "add_comment": {
        const { cardId: rawId, text } = args as any;
        const cardId = semantics.extractCardId(rawId);
        await client.addComment(cardId, text);
        return { content: [{ type: "text", text: "Comment added." }] };
      }

      case "search_members": {
        const { boardId, query } = args as any;
        const members = await client.getBoardMembers(boardId);
        const q = query.toLowerCase();
        const filtered = members.filter((m: any) => 
          m.fullName.toLowerCase().includes(q) || 
          m.username.toLowerCase().includes(q)
        );
        return { content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }] };
      }
      
      case "create_label": {
        const { boardId, name, color } = args as any;
        const label = await client.createLabel(boardId, name, color);
        return { content: [{ type: "text", text: JSON.stringify(label, null, 2) }] };
      }

      case "add_label_to_card": {
        const { cardId: rawId, labelId } = args as any;
        const cardId = semantics.extractCardId(rawId);
        await client.addLabelToCard(cardId, labelId);
        return { content: [{ type: "text", text: "Label added successfully." }] };
      }

      case "remove_label_from_card": {
        const { cardId: rawId, labelId } = args as any;
        const cardId = semantics.extractCardId(rawId);
        await client.removeLabelFromCard(cardId, labelId);
        return { content: [{ type: "text", text: "Label removed successfully." }] };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error: any) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
