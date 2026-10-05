import {
  TrelloBoard,
  TrelloCard,
  TrelloChecklist,
  TrelloList,
  TrelloConfig,
  TrelloCustomField,
  TrelloMember,
  TrelloNotification,
  CardComment,
  CardDetail
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
    const openBoards = await this.getMyBoards();
    if (!openBoards.some(b => b.id === boardId)) {
      throw new Error(`Board ${boardId} is closed/archived or does not exist. Only active boards can be queried.`);
    }
    const lists = await this.request<TrelloList[]>(`/boards/${encodeURIComponent(boardId)}/lists`, {
      params: { filter: 'open', fields: 'id,name,idBoard,closed' }
    });
    return (lists || []).filter(l => !l.closed);
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

  async getCard(cardId: string, checkActive: boolean = true): Promise<TrelloCard> {
    const card = await this.request<TrelloCard>(`/cards/${encodeURIComponent(cardId)}`, {
      params: { customFieldItems: true, fields: 'all' }
    });
    if (checkActive && card.closed) {
      throw new Error(`Card ${cardId} is archived/closed. Only active cards can be queried or modified.`);
    }
    return card;
  }

  /**
   * Verifies that a card is open AND resides on an active (open) board.
   */
  async ensureActiveCard(cardId: string): Promise<TrelloCard> {
    const card = await this.getCard(cardId, true);
    const openBoards = await this.getMyBoards();
    if (!openBoards.some(b => b.id === card.idBoard)) {
      throw new Error(`Card ${cardId} belongs to a closed/archived board (${card.idBoard}). Only active items can be queried or modified.`);
    }
    return card;
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
    // Explicitly reject any attempt to archive or close a card
    if (updates && (updates.closed === true || updates.closed === 'true')) {
      throw new Error("Archiving cards or closing boards is an unsupported operation in this MCP.");
    }
    if (updates && 'closed' in updates) {
      delete updates.closed;
    }
    await this.ensureActiveCard(cardId);
    return this.request(`/cards/${encodeURIComponent(cardId)}`, {
      method: 'PUT',
      body: updates
    });
  }

  async updateCustomField(cardId: string, customFieldId: string, value: any): Promise<void> {
    await this.ensureActiveCard(cardId);
    await this.request(`/cards/${encodeURIComponent(cardId)}/customField/${encodeURIComponent(customFieldId)}/item`, {
      method: 'PUT',
      body: { value }
    });
  }

  async getCardChecklists(cardId: string): Promise<TrelloChecklist[]> {
    await this.ensureActiveCard(cardId);
    return this.request(`/cards/${encodeURIComponent(cardId)}/checklists`, {
      params: { checkItems: 'all', checkItem_fields: 'name,state' }
    });
  }

  async createChecklist(cardId: string, name: string): Promise<TrelloChecklist> {
    await this.ensureActiveCard(cardId);
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
    await this.ensureActiveCard(cardId);
    await this.request(`/cards/${encodeURIComponent(cardId)}/actions/comments`, {
      method: 'POST',
      body: { text }
    });
  }

  async addLabelToCard(cardId: string, labelId: string): Promise<void> {
    await this.ensureActiveCard(cardId);
    await this.request(`/cards/${encodeURIComponent(cardId)}/idLabels`, {
      method: 'POST',
      body: { value: labelId }
    });
  }

  async removeLabelFromCard(cardId: string, labelId: string): Promise<void> {
    await this.ensureActiveCard(cardId);
    await this.request(`/cards/${encodeURIComponent(cardId)}/idLabels/${encodeURIComponent(labelId)}`, {
      method: 'DELETE'
    });
  }

  async getBoardLabels(boardId: string): Promise<any[]> {
    const openBoards = await this.getMyBoards();
    if (!openBoards.some(b => b.id === boardId)) {
      throw new Error(`Board ${boardId} is closed/archived or does not exist. Only active boards can be queried.`);
    }
    return this.request(`/boards/${encodeURIComponent(boardId)}/labels`);
  }

  async createLabel(boardId: string, name: string, color: string): Promise<any> {
    const openBoards = await this.getMyBoards();
    if (!openBoards.some(b => b.id === boardId)) {
      throw new Error(`Board ${boardId} is closed/archived. Cannot create label on a closed board.`);
    }
    return this.request(`/boards/${encodeURIComponent(boardId)}/labels`, {
      method: 'POST',
      body: { name, color }
    });
  }

  async getCurrentMember(): Promise<TrelloMember> {
    return this.request('/members/me', {
      params: { fields: 'id,username,fullName' }
    });
  }

  async getNotifications(params: { read_filter?: string; limit?: number } = {}): Promise<TrelloNotification[]> {
    return this.request('/members/me/notifications', {
      params: {
        read_filter: params.read_filter || 'unread',
        limit: params.limit || 200
      }
    });
  }

  async markNotificationRead(id: string): Promise<void> {
    await this.request(`/notifications/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: { unread: false }
    });
  }

  async getCardComments(cardId: string, limit: number = 3, since?: Date | null): Promise<CardComment[]> {
    const params: Record<string, any> = { filter: 'commentCard', limit: Math.max(limit, 10) };
    if (since) {
      params.since = since.toISOString();
    }
    const actions: any[] = await this.request(`/cards/${encodeURIComponent(cardId)}/actions`, {
      params
    });
    return (actions || [])
      .filter(a => a.data?.text && a.data.text.trim().length > 0)
      .filter(a => !since || new Date(a.date) >= since)
      .slice(0, limit)
      .map(a => ({
        id: a.id,
        date: a.date,
        text: a.data.text.trim(),
        author: a.memberCreator?.fullName || a.memberCreator?.username || 'Unknown',
        authorUsername: a.memberCreator?.username || ''
      }));
  }

  async getList(listId: string): Promise<TrelloList> {
    const list = await this.request<TrelloList>(`/lists/${encodeURIComponent(listId)}`);
    if (list.closed) {
      throw new Error(`List ${listId} is archived/closed. Only active lists can be accessed.`);
    }
    return list;
  }

  async getMember(memberIdOrUsername: string = 'me'): Promise<TrelloMember> {
    return this.request(`/members/${encodeURIComponent(memberIdOrUsername)}`, {
      params: { fields: 'id,username,fullName' }
    });
  }

  async getMemberCards(memberIdOrUsername: string = 'me'): Promise<any[]> {
    return this.request(`/members/${encodeURIComponent(memberIdOrUsername)}/cards`, {
      params: {
        filter: 'open',
        fields: 'id,name,desc,due,dueComplete,dateLastActivity,idBoard,idList,shortUrl,labels,idMembers,closed',
        list: 'true',
        board: 'true'
      }
    });
  }

  async getCardDetail(cardId: string): Promise<CardDetail> {
    const [card, comments]: [any, CardComment[]] = await Promise.all([
      this.request(`/cards/${encodeURIComponent(cardId)}`, {
        params: { fields: 'id,name,dueComplete,due,idList,desc,closed', members: 'true' }
      }),
      this.getCardComments(cardId, 3)
    ]);

    let listName: string | undefined;
    if (card.idList) {
      try {
        const list = await this.getList(card.idList);
        listName = list.name;
      } catch {}
    }

    return {
      id: card.id,
      name: card.name,
      dueComplete: card.dueComplete ?? false,
      due: card.due,
      listName,
      desc: card.desc || undefined,
      closed: Boolean(card.closed),
      comments,
      assignees: (card.members || []).map((m: any) => ({
        id: m.id,
        fullName: m.fullName,
        username: m.username
      }))
    };
  }

  /**
   * Batch fetches list metadata (name, closed) for multiple list IDs.
   */
  async getListsByIds(listIds: string[]): Promise<Map<string, { id: string; name: string; closed: boolean }>> {
    const map = new Map<string, { id: string; name: string; closed: boolean }>();
    if (listIds.length === 0) return map;

    const uniqueIds = [...new Set(listIds)];
    const chunkSize = 10;
    for (let i = 0; i < uniqueIds.length; i += chunkSize) {
      const chunk = uniqueIds.slice(i, i + chunkSize);
      const urls = chunk.map(id => `/lists/${encodeURIComponent(id)}?fields=name,closed,idBoard`).join(',');
      try {
        const batchResults = await this.request<any[]>(`/batch`, {
          params: { urls }
        });
        if (Array.isArray(batchResults)) {
          batchResults.forEach((resObj, idx) => {
            const listId = chunk[idx];
            const data = resObj?.['200'] || (resObj && typeof resObj.name === 'string' ? resObj : null);
            if (data && data.name) {
              map.set(listId, { id: listId, name: data.name, closed: Boolean(data.closed) });
            }
          });
        }
      } catch {
        await Promise.all(
          chunk.map(async (id) => {
            try {
              const list = await this.request<any>(`/lists/${encodeURIComponent(id)}`, {
                params: { fields: 'name,closed' }
              });
              if (list && list.name) {
                map.set(id, { id, name: list.name, closed: Boolean(list.closed) });
              }
            } catch {}
          })
        );
      }
    }
    return map;
  }

  /**
   * Batch fetches the latest action (author, type, date) for multiple cards.
   */
  async getCardsLatestAction(cardIds: string[]): Promise<Map<string, { date: string; type: string; actorName: string; actorUsername: string; isAutomation: boolean }>> {
    const map = new Map<string, { date: string; type: string; actorName: string; actorUsername: string; isAutomation: boolean }>();
    if (cardIds.length === 0) return map;

    const uniqueIds = [...new Set(cardIds)];
    const chunkSize = 10;
    for (let i = 0; i < uniqueIds.length; i += chunkSize) {
      const chunk = uniqueIds.slice(i, i + chunkSize);
      const urls = chunk.map(id => `/cards/${encodeURIComponent(id)}/actions?limit=1&filter=all`).join(',');
      try {
        const batchResults = await this.request<any[]>(`/batch`, {
          params: { urls }
        });
        if (Array.isArray(batchResults)) {
          batchResults.forEach((resObj, idx) => {
            const cardId = chunk[idx];
            const actions = resObj?.['200'] || (Array.isArray(resObj) ? resObj : null);
            if (Array.isArray(actions) && actions.length > 0) {
              const a = actions[0];
              const actorName = a.memberCreator?.fullName || a.memberCreator?.username || 'Unknown';
              const actorUsername = a.memberCreator?.username || '';
              const lowerActor = `${actorName} ${actorUsername}`.toLowerCase();
              const isAutomation = lowerActor.includes('automation') || lowerActor.includes('butler') || lowerActor.includes('bot');
              map.set(cardId, {
                date: a.date,
                type: a.type,
                actorName,
                actorUsername,
                isAutomation
              });
            }
          });
        }
      } catch {
        await Promise.all(
          chunk.map(async (id) => {
            try {
              const actions = await this.request<any[]>(`/cards/${encodeURIComponent(id)}/actions`, {
                params: { limit: 1, filter: 'all' }
              });
              if (Array.isArray(actions) && actions.length > 0) {
                const a = actions[0];
                const actorName = a.memberCreator?.fullName || a.memberCreator?.username || 'Unknown';
                const actorUsername = a.memberCreator?.username || '';
                const lowerActor = `${actorName} ${actorUsername}`.toLowerCase();
                const isAutomation = lowerActor.includes('automation') || lowerActor.includes('butler') || lowerActor.includes('bot');
                map.set(id, {
                  date: a.date,
                  type: a.type,
                  actorName,
                  actorUsername,
                  isAutomation
                });
              }
            } catch {}
          })
        );
      }
    }
    return map;
  }

  /**
   * Checks closed/archived status for multiple cards in batches of 10.
   * Returns a Map of cardId -> isClosed (true = archived/closed, false = active/open).
   */
  async getCardsClosedStatus(cardIds: string[]): Promise<Map<string, boolean>> {
    const statusMap = new Map<string, boolean>();
    if (cardIds.length === 0) return statusMap;

    const chunkSize = 10;
    for (let i = 0; i < cardIds.length; i += chunkSize) {
      const chunk = cardIds.slice(i, i + chunkSize);
      const urls = chunk.map(id => `/cards/${encodeURIComponent(id)}?fields=closed`).join(',');
      try {
        const batchResults = await this.request<any[]>(`/batch`, {
          params: { urls }
        });

        if (Array.isArray(batchResults)) {
          batchResults.forEach((resObj, idx) => {
            const cardId = chunk[idx];
            const res200 = resObj?.['200'] || (resObj && typeof resObj.closed === 'boolean' ? resObj : null);
            if (res200 && typeof res200.closed === 'boolean') {
              statusMap.set(cardId, Boolean(res200.closed));
            } else {
              // 404 or other error -> card deleted or inaccessible, treat as closed
              statusMap.set(cardId, true);
            }
          });
        }
      } catch {
        // Fallback to individual requests if batch fails
        await Promise.all(
          chunk.map(async (cardId) => {
            try {
              const card = await this.request<any>(`/cards/${encodeURIComponent(cardId)}`, {
                params: { fields: 'closed' }
              });
              statusMap.set(cardId, Boolean(card.closed));
            } catch {
              statusMap.set(cardId, true);
            }
          })
        );
      }
    }

    return statusMap;
  }
}

