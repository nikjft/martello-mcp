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
const BASE_URL = 'https://api.trello.com/1';

export class TrelloClient {
  private apiKey: string;
  private token: string;
  private lastRequestTime: number = 0;

  constructor(config: TrelloConfig) {
    this.apiKey = config.apiKey;
    this.token = config.token;
  }

  private async rateLimitDelay() {
    const now = Date.now();
    const timeSinceLast = now - this.lastRequestTime;
    if (timeSinceLast < DELAY_MS) {
      await new Promise(resolve => setTimeout(resolve, DELAY_MS - timeSinceLast));
    }
    this.lastRequestTime = Date.now();
  }

  private async request<T>(
    endpoint: string,
    options: {
      method?: string;
      params?: Record<string, any>;
      body?: any;
    } = {},
    attempt: number = 1
  ): Promise<T> {
    await this.rateLimitDelay();

    const method = options.method || 'GET';
    const url = new URL(`${BASE_URL}${endpoint}`);

    const headers: Record<string, string> = {
      'Accept': 'application/json'
    };

    if (this.token && !this.token.startsWith('ATTA') && this.token.length > 30) {
      headers['Authorization'] = `Bearer ${this.token}`;
      if (this.apiKey) {
        url.searchParams.set('key', this.apiKey);
      }
    } else {
      if (this.apiKey) {
        url.searchParams.set('key', this.apiKey);
      }
      if (this.token) {
        url.searchParams.set('token', this.token);
      }
    }

    let body: string | undefined;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }

    try {
      const response = await fetch(url.toString(), {
        method,
        headers,
        body
      });

      if (response.status === 429 && attempt <= MAX_RETRIES) {
        const backoff = 10000 * attempt;
        console.warn(`Trello rate-limited. Waiting ${backoff}ms...`);
        await new Promise(resolve => setTimeout(resolve, backoff));
        return this.request<T>(endpoint, options, attempt + 1);
      }

      if (!response.ok) {
        let errBody: string;
        try {
          errBody = await response.text();
        } catch {
          errBody = response.statusText;
        }
        throw new Error(`Trello API Error: ${response.status} - ${errBody}`);
      }

      const text = await response.text();
      if (!text) {
        return {} as T;
      }
      return JSON.parse(text) as T;
    } catch (error: any) {
      if (error.message?.startsWith('Trello API Error:')) {
        throw error;
      }
      if (attempt <= MAX_RETRIES) {
        const backoff = 1000 * attempt;
        await new Promise(resolve => setTimeout(resolve, backoff));
        return this.request<T>(endpoint, options, attempt + 1);
      }
      throw new Error(`Trello Request Failed: ${error.message}`);
    }
  }

  async getBoardMembers(boardId: string): Promise<any[]> {
    return this.request(`/boards/${encodeURIComponent(boardId)}/members`);
  }

  async getMyBoards(): Promise<TrelloBoard[]> {
    return this.request('/members/me/boards', {
      params: { filter: 'open', fields: 'id,name,closed,url' }
    });
  }

  async getBoardLists(boardId: string): Promise<TrelloList[]> {
    return this.request(`/boards/${encodeURIComponent(boardId)}/lists`, {
      params: { filter: 'all', fields: 'id,name,idBoard,closed' }
    });
  }

  async getCustomFields(boardId: string): Promise<TrelloCustomField[]> {
    return this.request(`/boards/${encodeURIComponent(boardId)}/customFields`);
  }

  async searchCards(query: string): Promise<TrelloCard[]> {
    const res = await this.request<{ cards: TrelloCard[] }>('/search', {
      params: { query, modelTypes: 'cards', cards_limit: 1000 }
    });
    return res.cards || [];
  }

  async getCard(cardId: string): Promise<TrelloCard> {
    return this.request(`/cards/${encodeURIComponent(cardId)}`, {
      params: { customFieldItems: true }
    });
  }

  async createCard(
    listId: string,
    name: string,
    desc?: string,
    dueDate?: string,
    startDate?: string
  ): Promise<TrelloCard> {
    return this.request('/cards', {
      method: 'POST',
      body: {
        idList: listId,
        name,
        desc,
        due: dueDate,
        start: startDate
      }
    });
  }

  async updateCard(cardId: string, updates: any): Promise<TrelloCard> {
    return this.request(`/cards/${encodeURIComponent(cardId)}`, {
      method: 'PUT',
      body: updates
    });
  }

  async updateCustomField(cardId: string, customFieldId: string, value: any): Promise<void> {
    await this.request(`/cards/${encodeURIComponent(cardId)}/customField/${encodeURIComponent(customFieldId)}/item`, {
      method: 'PUT',
      body: { value }
    });
  }

  async getCardChecklists(cardId: string): Promise<TrelloChecklist[]> {
    return this.request(`/cards/${encodeURIComponent(cardId)}/checklists`, {
      params: { checkItems: 'all', checkItem_fields: 'name,state' }
    });
  }

  async createChecklist(cardId: string, name: string): Promise<TrelloChecklist> {
    return this.request(`/cards/${encodeURIComponent(cardId)}/checklists`, {
      method: 'POST',
      body: { name }
    });
  }

  async addChecklistItem(checklistId: string, name: string): Promise<void> {
    await this.request(`/checklists/${encodeURIComponent(checklistId)}/checkItems`, {
      method: 'POST',
      body: { name }
    });
  }

  async removeChecklistItem(checklistId: string, idCheckItem: string): Promise<void> {
    await this.request(`/checklists/${encodeURIComponent(checklistId)}/checkItems/${encodeURIComponent(idCheckItem)}`, {
      method: 'DELETE'
    });
  }

  async addComment(cardId: string, text: string): Promise<void> {
    await this.request(`/cards/${encodeURIComponent(cardId)}/actions/comments`, {
      method: 'POST',
      body: { text }
    });
  }

  async addLabelToCard(cardId: string, labelId: string): Promise<void> {
    await this.request(`/cards/${encodeURIComponent(cardId)}/idLabels`, {
      method: 'POST',
      body: { value: labelId }
    });
  }

  async removeLabelFromCard(cardId: string, labelId: string): Promise<void> {
    await this.request(`/cards/${encodeURIComponent(cardId)}/idLabels/${encodeURIComponent(labelId)}`, {
      method: 'DELETE'
    });
  }

  async getBoardLabels(boardId: string): Promise<any[]> {
    return this.request(`/boards/${encodeURIComponent(boardId)}/labels`);
  }

  async createLabel(boardId: string, name: string, color: string): Promise<any> {
    return this.request(`/boards/${encodeURIComponent(boardId)}/labels`, {
      method: 'POST',
      body: { name, color }
    });
  }
}
