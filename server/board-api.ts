import { cfg } from './config';
import * as trello from './trello';
import { moveCard } from './runner/board';
import { snapshot } from './runner/board-snapshot';
import { cardIdOf } from './runner/board-trello';
import { knownColumns } from './runner/columns';
import { log } from './runner/log';
import { serial } from './runner/loop';

/**
 * The board for a session: which column an issue's card is in, and a move. A session on a GitHub board
 * has `gh project` for both; on any other board it has this — `SLOTH_BOARD_API` in its environment,
 * reached from the machine Sloth runs on, so the plugin's `board` skill needs to know one shape of board
 * and not each provider's API. The column read is the card's list as Trello has it now — a session
 * decides on it (whether the card is still in progress before it hands over), and a human's move of five
 * minutes ago must count; the last board tick's (`board-snapshot.ts`) answers when Trello does not. The
 * move goes on the tick chain like every other mutation.
 */

export interface CardInfo {
  issue: number;
  /** The column the card sits in, as of the last board read; empty when the issue has no card. */
  column: string;
  asOf: string;
}

const columnByName = (name: string) => knownColumns().find((c) => c.id === name || c.name.toLowerCase() === name.toLowerCase());

/** `GET /api/board/card/<issue>` — the card's column: live from Trello when the card is known, else from the last read. */
export async function cardInfo(issue: number): Promise<CardInfo> {
  const cardId = cfg().project.provider === 'trello' ? cardIdOf(issue) : undefined;
  if (cardId) {
    try {
      const listId = (await trello.card(cardId)).idList;
      const column = knownColumns().find((c) => c.id === listId);
      if (column) return { issue, column: column.name, asOf: new Date().toISOString() };
    } catch (e) {
      log(`#${issue} card read from Trello failed, answering from the last board read — ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
    }
  }
  const last = snapshot();
  const item = last?.items.find((i) => i.number === issue);
  return { issue, column: item?.status ?? '', asOf: last ? new Date(last.at).toISOString() : '' };
}

/**
 * `POST /api/board/move {issue, column}` — the column by name (case-insensitively) or id, among the ones the
 * last column refresh saw. An unknown column is a 400, never a guess: the session says which columns exist.
 */
export async function moveFromSession(body: unknown): Promise<{ ok: boolean; issue: number; column: string; error?: string }> {
  const b = (body ?? {}) as { issue?: unknown; column?: unknown };
  const issue = Number(b.issue);
  const wanted = typeof b.column === 'string' ? b.column.trim() : '';
  if (!Number.isInteger(issue) || issue <= 0 || !wanted) return { ok: false, issue, column: wanted, error: 'issue (a number) and column (a name or id) are required' };
  const column = columnByName(wanted);
  if (!column) return { ok: false, issue, column: wanted, error: `no such column: ${wanted} — the board has ${knownColumns().map((c) => c.name).join(', ') || 'no columns read yet'}` };
  const moved = (await serial('board move', () => moveCard(issue, column.id))) === true;
  return { ok: moved, issue, column: column.name, ...(moved ? {} : { error: 'the move failed — watcher.log says why' }) };
}

/** Whether a board API path is one; the handler in `api.ts` keeps the request local. */
export const isBoardApi = (p: string): boolean => p.startsWith('/api/board/');

export async function handleBoardApi(p: string, method: string, body: unknown): Promise<unknown> {
  if (!cfg().configured) return undefined;
  const card = /^\/api\/board\/card\/(\d+)$/.exec(p);
  if (card && method === 'GET') return cardInfo(Number(card[1]));
  if (p === '/api/board/move' && method === 'POST') return moveFromSession(body);
  return undefined;
}
