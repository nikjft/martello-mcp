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
  start?: string;
  dueComplete?: boolean;
  closed?: boolean;
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

export interface TrelloMember {
  id: string;
  username: string;
  fullName: string;
}

export interface TrelloNotification {
  id: string;
  idMemberCreator: string;
  memberCreator?: TrelloMember;
  type: 'addedToCard' | 'mentionedOnCard' | 'commentCard' | string;
  date: string;
  unread: boolean;
  data: {
    card?: { id: string; name: string; shortLink?: string };
    board?: { id: string; name: string };
    list?: { id: string; name: string };
    text?: string;
    member?: { id: string; username: string; fullName: string };
  };
}

export interface CardComment {
  id: string;
  date: string;
  text: string;
  author: string;
  authorUsername: string;
}

export interface CardDetail {
  id: string;
  name: string;
  dueComplete: boolean;
  due?: string;
  listName?: string;
  desc?: string;
  closed?: boolean;
  comments: CardComment[];
  assignees: { id: string; fullName: string; username: string }[];
  associatedNotificationIds?: string[];
}

