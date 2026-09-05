import { cfg } from '../config';
import { label } from '../repos';
import type { IssueRef } from '../repo-types';
import { moveTrelloCard } from './board-trello';
import { gh } from './gh';
import { isDry, log } from './log';

/**
 * The one writer to the board: a card moved from one column to another, whatever the board is. The
 * reader and everything derived from it are `board.ts`, which re-exports this so no caller has to know
 * the two are apart.
 */

/** Whether the board Sloth watches is a Trello board rather than a GitHub Projects one. */
export const onTrello = (): boolean => cfg().project.provider === 'trello';

/**
 * How a move ended. `refused` is the board's answer — no such column, no such card — and asking again
 * changes nothing; `unavailable` is a socket reset, a 5xx, a rate limit, and asking again is exactly
 * what to do. A session's `board_move` used to be told 400 for both, which its skill reads as final:
 * one Trello 503 on the hand-over left the card in In Progress with a finished run behind it, and
 * trigger 2 relaunched the session until `maxRetries` parked the card.
 */
export type MoveOutcome = 'moved' | 'refused' | 'unavailable';

/** Moves an issue's card to a column — a Status option, or a Trello list — adding it to a Projects board first if it is not on it. */
export const moveCard = async (issue: IssueRef, optionId: string): Promise<boolean> => (await moveCardOutcome(issue, optionId)) === 'moved';

/** The same move, for a caller that has to tell a board that refused from one that could not be reached. */
export async function moveCardOutcome(issue: IssueRef, optionId: string): Promise<MoveOutcome> {
  const c = cfg();
  if (!optionId) {
    log(`${label(issue)} move skipped: empty option id`);
    return 'refused';
  }
  if (onTrello()) return moveTrelloCard(issue, optionId);
  if (isDry()) {
    log(`dry-run: would move ${label(issue)} to ${optionId}`);
    return 'moved';
  }
  const add = await gh([
    'project', 'item-add', String(c.project.number), '--owner', c.project.owner,
    '--url', `https://github.com/${issue.repo}/issues/${issue.number}`, '--format', 'json', '--jq', '.id',
  ]);
  // The column was checked against the board before the call, so what fails here is `gh` reaching GitHub.
  if (!add.ok) {
    log(`${label(issue)} move failed (item-add): ${add.err.split('\n')[0]}`);
    return 'unavailable';
  }
  const edit = await gh([
    'project', 'item-edit', '--id', add.out, '--project-id', c.project.id,
    '--field-id', c.statusField.id, '--single-select-option-id', optionId,
  ]);
  if (!edit.ok) log(`${label(issue)} move failed (item-edit): ${edit.err.split('\n')[0]}`);
  return edit.ok ? 'moved' : 'unavailable';
}
