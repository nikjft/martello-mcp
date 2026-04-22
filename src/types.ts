export interface TrelloConfig {
  apiKey: string;
  token: string;
}

export interface TrelloCard {
  id: string;
  name: string;
  desc: string;
  idList: string;
  idBoard: string;
  shortUrl: string;
  due?: string;
  dueComplete?: boolean;
  labels: { id: string; name: string; color: string }[];
  customFieldItems?: { idCustomField: string; value: { date?: string; text?: string; number?: number } }[];
}

export interface TrelloList {
  id: string;
  name: string;
  idBoard: string;
  closed: boolean;
}

export interface TrelloBoard {
  id: string;
  name: string;
  closed: boolean;
  url: string;
}

export interface TrelloChecklist {
  id: string;
  name: string;
  idCard: string;
  checkItems: TrelloCheckItem[];
}

export interface TrelloCheckItem {
  id: string;
  name: string;
  state: 'complete' | 'incomplete';
}

export interface TrelloCustomField {
  id: string;
  name: string;
  type: string;
}
