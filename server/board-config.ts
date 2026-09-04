/** The board half of the configuration: where it lives, and which of its columns play which role for Sloth. */

export interface ColumnRef {
  id: string;
  name: string;
}
/**
 * Where the board lives. `github` is a Projects (v2) board, the one Sloth has always watched; `trello` is a
 * Trello board whose lists are Sloth's columns (`runner/board-trello.ts`). The sessions work GitHub issues
 * and PRs either way: a Trello card is linked to the issue Sloth opens for it. A config from before the
 * field has no `provider` and loads as `github`.
 */
export type BoardProvider = 'github' | 'trello';
export const BOARD_PROVIDERS: BoardProvider[] = ['github', 'trello'];

export interface ConfigProject {
  provider: BoardProvider;
  /** The Projects (v2) node id, or the Trello board id. */
  id: string;
  /** The project number; `0` on Trello, which has none. */
  number: number;
  /** The login the project belongs to; on Trello the member the token belongs to, when known. */
  owner: string;
  title: string;
}
export interface ConfigColumns {
  pickup: ColumnRef;
  inProgress: ColumnRef;
  needsHelp: ColumnRef;
  codeReview: ColumnRef;
  /** Optional: with no Approved column a passing review leaves the card in Code Review and trigger 5 never fires. */
  approved: ColumnRef;
  /**
   * Optional: the column the QA sweep (trigger 9) tests — cards whose fix is merged and deployed to
   * `qa.branch`, waiting for a tester. Never created unless asked for; blank means no sweep.
   */
  qa: ColumnRef;
  /** Optional: where a card goes once its issue is closed (trigger 6), or once it passed the QA sweep; without it the card stays put. */
  done: ColumnRef;
}
export type ColumnRole = keyof ConfigColumns;

/** The names Sloth gives the columns it creates when the board has none for a role. */
export const DEFAULT_COLUMN_NAMES: Record<ColumnRole, string> = {
  pickup: 'Todo',
  inProgress: 'In Progress',
  needsHelp: 'Sloth needs help',
  codeReview: 'Code Review',
  approved: 'Approved',
  qa: 'QA',
  done: 'Done',
};

/** The roles a board need not have: left blank, the trigger that needs the column simply never fires. */
export const OPTIONAL_COLUMNS: ColumnRole[] = ['needsHelp', 'approved', 'qa', 'done'];
/** The roles that are never created unasked — the wizard offers "none" for them, and blank stays blank. */
export const OPT_IN_COLUMNS: ColumnRole[] = ['qa'];
