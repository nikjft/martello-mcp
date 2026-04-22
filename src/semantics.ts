import { TrelloClient } from './trello-client.js';
import { TrelloCard, TrelloChecklist } from './types.js';

const EXCLUDED_LIST_SUBSTRINGS = ["completed", "template", "backlog", "vice"];
const RELATIONSHIP_CHECKLISTS = ["parents", "children", "blocked by", "blocking", "related"];
const TRELLO_URL_RE = /https:\/\/trello\.com\/c\/([A-Za-z0-9]+)(?:\/[^\s]*)?/i;

export class McGawSemantics {
  constructor(private client: TrelloClient) {}

  extractCardId(input: string): string {
    // Matches https://trello.com/c/[ID]/... or just the [ID]
    const match = /https:\/\/trello\.com\/c\/([A-Za-z0-9]+)/i.exec(input);
    return match ? match[1] : input.trim();
  }

  isGroomed(cardName: string): boolean {
    const match = /\((\d+(\.\d+)?|\?)\)/.exec(cardName);
    if (!match) return false;
    const est = match[1];
    if (est === '?') return false;
    const val = parseFloat(est);
    if (val >= 200) return false;
    return true;
  }

  async getBoardMembers(boardId: string): Promise<any[]> {
    return this.client.getBoardMembers(boardId);
  }

  async getTargetListForDate(boardId: string, dueDate: Date, now: Date): Promise<string | null> {
    const lists = await this.client.getBoardLists(boardId);
    
    // Calculate weeks
    // This Week: Current week (Mon-Sun)
    // Next Week: Next week
    // Someday: Anything after next week
    
    const getWeekNumber = (d: Date) => {
      const firstDayOfYear = new Date(d.getFullYear(), 0, 1);
      const pastDaysOfYear = (d.getTime() - firstDayOfYear.getTime()) / 86400000;
      return Math.ceil((pastDaysOfYear + firstDayOfYear.getDay() + 1) / 7);
    };

    const nowWeek = getWeekNumber(now);
    const dueWeek = getWeekNumber(dueDate);
    const nowYear = now.getFullYear();
    const dueYear = dueDate.getFullYear();

    let targetName = "Someday";
    if (dueYear < nowYear || (dueYear === nowYear && dueWeek <= nowWeek)) {
      targetName = "This Week";
    } else if (dueYear === nowYear && dueWeek === nowWeek + 1) {
      targetName = "Next Week";
    }

    // Fallback names if exact match not found (e.g. "Next Week (Active)")
    const found = lists.find(l => l.name.toLowerCase().includes(targetName.toLowerCase()));
    return found ? found.id : null;
  }

  /**
   * Safe estimate updater: only updates the (Est) portion.
   * e.g., (1.5) My Task [2.0] -> (3.0) My Task [2.0]
   */
  public updateEstimate(title: string, newEstimate: number): string {
    const estRegex = /^\(([\d.]+)\)\s+/;
    if (estRegex.test(title)) {
      return title.replace(estRegex, `(${newEstimate}) `);
    } else {
      return `(${newEstimate}) ${title}`;
    }
  }

  /**
   * Link two cards bidirectionally
   * Supported: 'parent-child', 'blocker-blocked', 'related'
   */
  public async updateRelationship(
    sourceCard: TrelloCard,
    targetCard: TrelloCard,
    relationshipType: 'parent-child' | 'blocker-blocked' | 'related',
    action: 'link' | 'unlink'
  ) {
    let sourceChecklistName = '';
    let targetChecklistName = '';

    if (relationshipType === 'parent-child') {
      sourceChecklistName = 'children';
      targetChecklistName = 'parents';
    } else if (relationshipType === 'blocker-blocked') {
      sourceChecklistName = 'blocking';
      targetChecklistName = 'blocked by';
    } else if (relationshipType === 'related') {
      sourceChecklistName = 'related';
      targetChecklistName = 'related';
    }

    await this.syncChecklistItem(sourceCard, targetCard, sourceChecklistName, action);
    await this.syncChecklistItem(targetCard, sourceCard, targetChecklistName, action);

    // Handle labels for blockers
    if (relationshipType === 'blocker-blocked') {
      await this.syncBlockerLabels(sourceCard, targetCard, action);
    }
    
    // Handle epic cascade for parent-child
    if (relationshipType === 'parent-child' && action === 'link') {
       await this.cascadeEpicLabel(sourceCard, targetCard);
    }
  }

  private async syncChecklistItem(card: TrelloCard, otherCard: TrelloCard, checklistName: string, action: 'link' | 'unlink') {
    const checklists = await this.client.getCardChecklists(card.id);
    let checklist = checklists.find(c => c.name.toLowerCase() === checklistName.toLowerCase());

    if (action === 'link') {
      if (!checklist) {
        checklist = await this.client.createChecklist(card.id, checklistName);
      }
      // Check if already exists
      const exists = checklist.checkItems.some(item => item.name.includes(otherCard.shortUrl));
      if (!exists) {
        await this.client.addChecklistItem(checklist.id, `${otherCard.name} ${otherCard.shortUrl}`);
      }
    } else if (action === 'unlink' && checklist) {
      const item = checklist.checkItems.find(item => item.name.includes(otherCard.shortUrl));
      if (item) {
        await this.client.removeChecklistItem(checklist.id, item.id);
      }
    }
  }

  private async syncBlockerLabels(blocker: TrelloCard, blocked: TrelloCard, action: 'link' | 'unlink') {
    const blockerBoardLabels = await this.client.getBoardLabels(blocker.idBoard);
    const blockedBoardLabels = await this.client.getBoardLabels(blocked.idBoard);

    const blockerLabel = blockerBoardLabels.find(l => l.name?.toLowerCase() === 'blocker');
    const blockedLabel = blockedBoardLabels.find(l => l.name?.toLowerCase() === 'blocked');

    if (action === 'link') {
      if (blockerLabel && !blocker.labels.some(l => l.id === blockerLabel.id)) {
        await this.client.addLabelToCard(blocker.id, blockerLabel.id);
      }
      if (blockedLabel && !blocked.labels.some(l => l.id === blockedLabel.id)) {
        await this.client.addLabelToCard(blocked.id, blockedLabel.id);
      }
    } else {
      if (blockerLabel && blocker.labels.some(l => l.id === blockerLabel.id)) {
        await this.client.removeLabelFromCard(blocker.id, blockerLabel.id);
      }
      if (blockedLabel && blocked.labels.some(l => l.id === blockedLabel.id)) {
        await this.client.removeLabelFromCard(blocked.id, blockedLabel.id);
      }
    }
  }

  private async cascadeEpicLabel(parent: TrelloCard, child: TrelloCard) {
    // If parent has an Epic label, apply it to the child
    // Since epics might just use their name as the label name, we look for labels on the parent
    // The playbook says: "Each epic has an associated Trello label matching its epic name"
    // Here we just copy labels from parent to child if the parent is an Epic
    if (parent.name.includes('EPIC:') || parent.name.includes('SUB-EPIC:')) {
      const parentBoardLabels = await this.client.getBoardLabels(parent.idBoard);
      const childBoardLabels = await this.client.getBoardLabels(child.idBoard);
      
      for (const pLabel of parent.labels) {
        // Find matching label by name on child board
        const matchingChildLabel = childBoardLabels.find(l => l.name === pLabel.name);
        if (matchingChildLabel && !child.labels.some(l => l.id === matchingChildLabel.id)) {
          await this.client.addLabelToCard(child.id, matchingChildLabel.id);
        }
      }
    }
  }

  /**
   * Resolves the "Get it done Date" custom field ID for a specific board.
   */
  public async getItDoneDateFieldId(boardId: string): Promise<string | undefined> {
    const fields = await this.client.getCustomFields(boardId);
    const field = fields.find(f => f.name.toLowerCase() === 'get it done date');
    return field?.id;
  }

  public async getEpicLineage(epicCardUrlOrId: string): Promise<any> {
    // Basic extraction
    const match = TRELLO_URL_RE.exec(epicCardUrlOrId);
    const cardId = match ? match[1] : epicCardUrlOrId;
    
    return this.resolveLineageRecursive(cardId, 0);
  }

  private async resolveLineageRecursive(cardId: string, depth: number): Promise<any> {
    if (depth > 5) return { id: cardId, error: "Max depth reached" };
    const card = await this.client.getCard(cardId);
    const checklists = await this.client.getCardChecklists(cardId);
    
    const childrenChecklist = checklists.find(c => c.name.toLowerCase() === 'children');
    const children = [];

    if (childrenChecklist) {
      for (const item of childrenChecklist.checkItems) {
        const itemMatch = TRELLO_URL_RE.exec(item.name);
        if (itemMatch) {
          children.push(await this.resolveLineageRecursive(itemMatch[1], depth + 1));
        } else {
          children.push({ name: item.name });
        }
      }
    }

    return {
      title: card.name,
      url: card.shortUrl,
      children
    };
  }
}
