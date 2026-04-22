# Martello MCP: McGaw Trello Project Management

Martello is a specialized Model Context Protocol (MCP) server designed to automate and enforce the **McGaw Project Management Playbook** on Trello. Unlike generic Trello integrations, Martello understands specific semantic workflows like Epic label cascading, bidirectional relationship checklists, and smart scheduling based on (Est) title parsing.

## 🚀 Key Features

- **Semantic Grooming**: Automatically identifies "ungroomed" cards (those with placeholder estimates like 400, 404, or "?").
- **Epic Cascading**: Automatically applies Epic labels from parent cards to children when relationships are established.
- **Bidirectional Relationships**: Manages `parents`, `children`, `blockers`, and `related` cards using specialized Trello checklists and labels.
- **Smart Scheduling**: Automatically moves cards between `This Week`, `Next Week`, and `Someday` lists based on changes to their due dates.
- **Robust Referencing**: Supports full Trello URLs and Short Links as identifiers to prevent context confusion.
- **Safety First**: Implements rate-limiting and strictly forbids card/board deletion to protect your data.

---

## 🛠 Setup & Installation

### 1. Prerequisites
- [Node.js](https://nodejs.org/) (v16+)
- A Trello Account

### 2. Get Trello API Credentials
1.  Go to the [Trello Power-Up Admin Portal](https://trello.com/power-ups/admin).
2.  Create a new Power-Up (or use an existing one) to get your **API Key**.
3.  Generate a **Personal Token** by clicking the "Token" link next to your API Key.

### 3. Build the Server
```bash
git clone <your-repo-url>
cd martello-mcp
npm install
npm run build
```

---

## 🔌 Integration

### Antigravity / Claude Desktop
Add the following to your `mcp_config.json` (usually located in `~/Library/Application Support/Claude/claude_desktop_config.json` or `~/.gemini/antigravity/mcp_config.json`):

```json
{
  "mcpServers": {
    "mcgaw-trello": {
      "command": "node",
      "args": ["/absolute/path/to/martello-mcp/dist/index.js"],
      "env": {
        "TRELLO_API_KEY": "your_api_key_here",
        "TRELLO_TOKEN": "your_token_here"
      }
    }
  }
}
```

---

## 📖 Core Concepts

### Title Formats
The server parses and updates estimates stored in the title:
- `(1.5) My Task` -> Estimated 1.5 hours.
- `(404) My Task` -> Ungroomed/Needs attention.
- `(Est) My Task [Spent]` -> The server safely updates only the `(Est)` portion without touching `[Spent]`.

### Smart List Movement
When a card's due date is updated via the `update_card_details` tool, Martello automatically moves the card:
- **This Week**: Due within the current calendar week or past.
- **Next Week**: Due in the following calendar week.
- **Someday**: Due any time after next week.

### Relationship Management
Martello uses specific checklist names to track card lineages:
- **children / parents**: For parent-child and epic-subepic hierarchies.
- **blocked by / blocking**: Manages dependencies and applies the "Blocker" label.
- **related**: Links related tasks bidirectionally without hierarchy or dependency.

---

## 💡 Usage Examples

- **Grooming**: "Find all ungroomed cards on the Doctor Tavel board and summarize them."
- **Scheduling**: "Schedule https://trello.com/c/abc123yz for next Friday." (The server will update the due date and move it to the 'Next Week' list).
- **Assigning**: "Assign Sarah to the card at https://trello.com/c/xyz789 and add a comment that it's high priority."
- **Relationships**: "Make the card 'New Design' a child of the 'Website Refresh' Epic."

---

## 🛡 Security & Design
- **Read-Only Deletion**: The API client is hardcoded to reject any `DELETE` requests or archiving actions.
- **Silent Protocol**: All logs are suppressed to `stderr` to ensure the MCP JSON-RPC protocol on `stdout` remains clean and reliable.
