import { cfg } from './config';
import { isConfigured, primaryRepo } from './repos';
import { refKey, type IssueRef } from './repo-types';
import * as trello from './trello';
import { moveCardOutcome } from './runner/board';
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
 * move goes on the tick chain like every other mutation. The issue's repository comes with its number
 * (`?repo=` on the read, `repo` in the move's body); a session from before there were several sends none,
 * and means the first one.
 */

export interface CardInfo {
  repo: string;
  issue: number;
  /** The column the card sits in, as of the last board read; empty when the issue has no card. */
  column: string;
  asOf: string;
}

const columnByName = (name: string) => knownColumns().find((c) => c.id === name || c.name.toLowerCase() === name.toLowerCase());

/** The repository a session named, or the first one; undefined for one Sloth does not work in. */
function repoArg(v: unknown): string | undefined {
  const repo = typeof v === 'string' && v.trim() ? v.trim() : primaryRepo();
  return isConfigured(repo) ? repo : undefined;
}

/** `GET /api/board/card/<issue>?repo=owner/name` — the card's column: live from Trello when the card is known, else from the last read. */
export async function cardInfo(issue: IssueRef): Promise<CardInfo> {
  const cardId = cfg().project.provider === 'trello' ? cardIdOf(issue) : undefined;
  if (cardId) {
    try {
      const listId = (await trello.card(cardId)).idList;
      const column = knownColumns().find((c) => c.id === listId);
      if (column) return { repo: issue.repo, issue: issue.number, column: column.name, asOf: new Date().toISOString() };
    } catch (e) {
      log(`${refKey(issue)} card read from Trello failed, answering from the last board read — ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
    }
  }
  const last = snapshot();
  const item = last?.items.find((i) => refKey(i) === refKey(issue));
  return { repo: issue.repo, issue: issue.number, column: item?.status ?? '', asOf: last ? new Date(last.at).toISOString() : '' };
}

/** What a failed move answers with. `status` is not part of the JSON — `api-settings.ts` takes it off and uses it as the code. */
export interface MoveAnswer {
  ok: boolean;
  issue: number;
  repo?: string;
  column: string;
  error?: string;
  status?: number;
}

/**
 * `POST /api/board/move {issue, column, repo?}` — the column by name (case-insensitively) or id, among the ones
 * the last column refresh saw.
 *
 * What the session is told apart is what it does next: the `board_move` helper in its skill reads a 4xx as
 * the board's own answer and gives up at once, and retries anything else four times with a backoff. So a 400
 * is only for what asking again cannot mend — a malformed body, a repository Sloth does not work in, a column
 * this board does not have — and everything that failed on the way to the board is a 503. Every failure used
 * to be a 400: one Trello 503 on a hand-over left the card behind with a finished run, and a first column
 * read that failed after a restart gave every session launched in that tick "the board has no columns read
 * yet" as a permanent answer for its whole run.
 */
export async function moveFromSession(body: unknown): Promise<MoveAnswer> {
  const b = (body ?? {}) as { issue?: unknown; column?: unknown; repo?: unknown };
  const issue = Number(b.issue);
  const wanted = typeof b.column === 'string' ? b.column.trim() : '';
  if (!Number.isInteger(issue) || issue <= 0 || !wanted) return { ok: false, issue, column: wanted, error: 'issue (a number) and column (a name or id) are required', status: 400 };
  const repo = repoArg(b.repo);
  if (!repo) return { ok: false, issue, column: wanted, error: `${String(b.repo)} is not one of Sloth's repositories`, status: 400 };
  const column = columnByName(wanted);
  if (!column) {
    const names = knownColumns().map((c) => c.name);
    // No columns read yet is not "no such column": the board has not been asked, and the next tick asks again.
    return { ok: false, issue, repo, column: wanted, error: `no such column: ${wanted} — the board has ${names.join(', ') || 'no columns read yet'}`, status: names.length ? 400 : 503 };
  }
  const outcome = await serial('board move', () => moveCardOutcome({ repo, number: issue }, column.id));
  if (outcome === 'moved') return { ok: true, issue, repo, column: column.name };
  return {
    ok: false,
    issue,
    repo,
    column: column.name,
    error: `the move failed — watcher.log says why`,
    status: outcome === 'refused' ? 400 : 503,
  };
}

/** Whether a board API path is one; the handler in `api.ts` keeps the request local. */
export const isBoardApi = (p: string): boolean => p.startsWith('/api/board/');

export async function handleBoardApi(p: string, method: string, body: unknown, repo?: string | null): Promise<unknown> {
  if (!cfg().configured) return undefined;
  const card = /^\/api\/board\/card\/(\d+)$/.exec(p);
  if (card && method === 'GET') {
    const slug = repoArg(repo);
    return slug ? cardInfo({ repo: slug, number: Number(card[1]) }) : undefined;
  }
  if (p === '/api/board/move' && method === 'POST') return moveFromSession(body);
  return undefined;
}
