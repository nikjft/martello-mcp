import axios, { AxiosInstance } from 'axios';
import {
  TrelloBoard,
  TrelloCard,
  TrelloChecklist,
  TrelloList,
  TrelloConfig,
  TrelloCustomField
} from './types.js';

const DELAY_MS = 120;
const MAX_RETRIES = 4;

export class TrelloClient {
  private axiosInstance: AxiosInstance;
  private lastRequestTime: number = 0;

  constructor(config: TrelloConfig) {
    this.axiosInstance = axios.create({
      baseURL: 'https://api.trello.com/1',
      params: {
        key: config.apiKey,
        token: config.token,
      },
    });
  }

  private async rateLimitDelay() {
    const now = Date.now();
    const timeSinceLast = now - this.lastRequestTime;
    if (timeSinceLast < DELAY_MS) {
      await new Promise(resolve => setTimeout(resolve, DELAY_MS - timeSinceLast));
    }
    this.lastRequestTime = Date.now();
  }

  private async handleRequest<T>(requestFn: () => Promise<T>, attempt: number = 1): Promise<T> {
    await this.rateLimitDelay();
    try {
      return await requestFn();
    } catch (error: any) {
      if (error.response?.status === 429 && attempt <= MAX_RETRIES) {
        const backoff = 10000 * attempt; // 10s * attempt, same as python logic
        console.warn(`Trello rate-limited. Waiting ${backoff}ms...`);
        await new Promise(resolve => setTimeout(resolve, backoff));
        return this.handleRequest(requestFn, attempt + 1);
      }
      throw new Error(`Trello API Error: ${error.response?.status} - ${JSON.stringify(error.response?.data) || error.message}`);
    }
  }

  async getBoardMembers(boardId: string): Promise<any[]> {
    return this.handleRequest(async () => {
      const res = await this.axiosInstance.get(`/boards/${boardId}/members`);
      return res.data;
    });
  }

  async getMyBoards(): Promise<TrelloBoard[]> {
    return this.handleRequest(async () => {
      const res = await this.axiosInstance.get('/members/me/boards', {
        params: { filter: 'open', fields: 'id,name,closed,url' }
      });
      return res.data;
    });
  }

  async getBoardLists(boardId: string): Promise<TrelloList[]> {
    return this.handleRequest(async () => {
      const res = await this.axiosInstance.get(`/boards/${boardId}/lists`, {
        params: { filter: 'all', fields: 'id,name,idBoard,closed' }
      });
      return res.data;
    });
  }

  async getCustomFields(boardId: string): Promise<TrelloCustomField[]> {
    return this.handleRequest(async () => {
      const res = await this.axiosInstance.get(`/boards/${boardId}/customFields`);
      return res.data;
    });
  }

  async searchCards(query: string): Promise<TrelloCard[]> {
    return this.handleRequest(async () => {
      const res = await this.axiosInstance.get('/search', {
        params: { query, modelTypes: 'cards', cards_limit: 1000 }
      });
      return res.data.cards;
    });
  }

  async getCard(cardId: string): Promise<TrelloCard> {
    return this.handleRequest(async () => {
      const res = await this.axiosInstance.get(`/cards/${cardId}`, {
        params: { customFieldItems: true }
      });
      return res.data;
    });
  }

  async createCard(listId: string, name: string, desc?: string, dueDate?: string, startDate?: string): Promise<TrelloCard> {
    return this.handleRequest(async () => {
      const res = await this.axiosInstance.post('/cards', {
        idList: listId,
        name,
        desc,
        due: dueDate,
        start: startDate
      });
      return res.data;
    });
  }

  async updateCard(cardId: string, updates: any): Promise<TrelloCard> {
    return this.handleRequest(async () => {
      const res = await this.axiosInstance.put(`/cards/${cardId}`, updates);
      return res.data;
    });
  }

  async updateCustomField(cardId: string, customFieldId: string, value: any): Promise<void> {
    return this.handleRequest(async () => {
      await this.axiosInstance.put(`/cards/${cardId}/customField/${customFieldId}/item`, {
        value
      });
    });
  }

  async getCardChecklists(cardId: string): Promise<TrelloChecklist[]> {
    return this.handleRequest(async () => {
      const res = await this.axiosInstance.get(`/cards/${cardId}/checklists`, {
        params: { checkItems: 'all', checkItem_fields: 'name,state' }
      });
      return res.data;
    });
  }

  async createChecklist(cardId: string, name: string): Promise<TrelloChecklist> {
    return this.handleRequest(async () => {
      const res = await this.axiosInstance.post(`/cards/${cardId}/checklists`, { name });
      return res.data;
    });
  }

  async addChecklistItem(checklistId: string, name: string): Promise<void> {
    return this.handleRequest(async () => {
      await this.axiosInstance.post(`/checklists/${checklistId}/checkItems`, { name });
    });
  }

  async removeChecklistItem(checklistId: string, idCheckItem: string): Promise<void> {
    return this.handleRequest(async () => {
      await this.axiosInstance.delete(`/checklists/${checklistId}/checkItems/${idCheckItem}`);
    });
  }

  async addComment(cardId: string, text: string): Promise<void> {
    return this.handleRequest(async () => {
      await this.axiosInstance.post(`/cards/${cardId}/actions/comments`, { text });
    });
  }

  async addLabelToCard(cardId: string, labelId: string): Promise<void> {
    return this.handleRequest(async () => {
      await this.axiosInstance.post(`/cards/${cardId}/idLabels`, { value: labelId });
    });
  }
  
  async removeLabelFromCard(cardId: string, labelId: string): Promise<void> {
    return this.handleRequest(async () => {
      await this.axiosInstance.delete(`/cards/${cardId}/idLabels/${labelId}`);
    });
  }

  async getBoardLabels(boardId: string): Promise<any[]> {
    return this.handleRequest(async () => {
      const res = await this.axiosInstance.get(`/boards/${boardId}/labels`);
      return res.data;
    });
  }

  async createLabel(boardId: string, name: string, color: string): Promise<any> {
    return this.handleRequest(async () => {
      const res = await this.axiosInstance.post(`/boards/${boardId}/labels`, {
        name,
        color
      });
      return res.data;
    });
  }
}
