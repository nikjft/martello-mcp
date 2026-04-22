import dotenv from 'dotenv';
import { TrelloClient } from './src/trello-client.js';

dotenv.config();

async function run() {
  const client = new TrelloClient({
    apiKey: process.env.TRELLO_API_KEY!,
    token: process.env.TRELLO_TOKEN!
  });

  const boards = await client.getMyBoards();
  const testBoard = boards.find(b => b.shortUrl?.includes('12rbjNdG') || b.url?.includes('12rbjNdG'));
  console.log("Found boards:", boards.length);
  if (testBoard) {
    console.log("Found Test Board:", testBoard.name);
    const lists = await client.getBoardLists(testBoard.id);
    console.log("Lists in test board:", lists.map(l => l.name));
  } else {
    console.log("Test board not found in recent open boards.");
  }
}

run().catch(console.error);
