import { cfg } from './config';
import { issueOf } from './issue-costs';
import { snapshot } from './runner/board-snapshot';
import { DONE_DAYS, PIPELINE, skipped } from './board-types';
import type { BoardCard, BoardColumn, BoardView } from './board-types';
import type { BoardItem } from './runner/board';
import type { ColumnRole, ConfigColumns } from './config-types';
import type { IssueCost, SessionSummary } from './types';

/**
 * Joins the board Sloth last read to the runs it started on those cards, so the home panel can answer
 * "where is every card, and is Sloth on it?" without a request of its own. Kept apart from
 * `sessions.ts` so the join stays a pure function `test/board-view.test.ts` can call directly.
 */

const DONE_MS = DONE_DAYS * 86_400_000;

/**
 * The newest run per issue. An implement run is named after its issue; a review is
 * named after the PR and carries the issue beside it (`issueOf`), so a review that started after the
 * implement run is the one the card shows.
 */
function newestByIssue(sessions: SessionSummary[]): Map<number, SessionSummary> {
  const out = new Map<number, SessionSummary>();
  for (const s of sessions) {
    const issue = issueOf(s);
    if (!issue) continue;
    const seen = out.get(issue);
    if (!seen || (s.startedAt ?? '') > (seen.startedAt ?? '')) out.set(issue, s);
  }
  return out;
}

/** Done keeps the last week. The board carries no close date, so the newest run's last activity stands in for one. */
const recent = (s: SessionSummary, now: number): boolean => !s.lastAt || now - Date.parse(s.lastAt) <= DONE_MS;

/**
 * Whether a card is Sloth's: it has a run on it, or it sits in the pickup column without the skip
 * label — the queue Sloth takes from. Anything else on Sloth's columns is a person's work, moved by hand, and the board
 * only counts it (`others`): this view is what Sloth is doing, not what the team is doing.
 */
const sloths = (role: ColumnRole, item: BoardItem, s: SessionSummary | undefined): boolean => !!s || (role === 'pickup' && !skipped(item));

function cardOf(item: BoardItem, s: SessionSummary | undefined, cost: number | null): BoardCard {
  const w = s?.watcher;
  const preview = w?.preview;
  // "Waiting since" only means something while the run is actually waiting for an answer.
  const held = s?.status === 'parked' || s?.status === 'waiting';
  return {
    issue: item.number,
    title: item.title,
    assignees: item.assignees,
    labels: item.labels,
    closed: item.closed,
    sessionId: s?.id,
    status: s?.status,
    step: w?.state?.step,
    kind: w?.kind,
    since: held ? w?.state?.since : undefined,
    retries: w?.retries ?? 0,
    pr: w?.state?.pr,
    // A preview whose tunnel has not printed an address yet is not a link anyone can follow.
    preview: preview?.url ? { url: preview.url, key: preview.key } : undefined,
    cost,
  };
}

/**
 * The whole view, from a board snapshot and the session list the overview already built. Sloth's
 * columns come out in pipeline order whatever order the GitHub board puts them in, a role the config
 * leaves blank is left out, every other Status option is counted into `elsewhere`, and a card on
 * Sloth's columns that is not Sloth's (`sloths`) is counted into `others`.
 */
export function buildBoardView(
  board: { at: number; items: BoardItem[] },
  columns: ConfigColumns,
  sessions: SessionSummary[],
  issues: IssueCost[],
  now = Date.now(),
): BoardView {
  const newest = newestByIssue(sessions);
  const costs = new Map(issues.map((i) => [i.issue, i.cost]));
  const out: BoardColumn[] = PIPELINE.filter((role) => columns[role]?.name).map((role) => ({
    role,
    id: columns[role].id,
    name: columns[role].name,
    cards: [],
  }));
  const byName = new Map(out.map((c) => [c.name, c]));
  let elsewhere = 0;
  let others = 0;
  for (const item of board.items) {
    const column = byName.get(item.status);
    if (!column) {
      elsewhere++;
      continue;
    }
    const s = newest.get(item.number);
    if (!sloths(column.role, item, s)) {
      others++;
      continue;
    }
    if (column.role === 'done' && s && !recent(s, now)) continue;
    column.cards.push(cardOf(item, s, costs.get(item.number) ?? null));
  }
  return { asOf: new Date(board.at).toISOString(), columns: out, elsewhere, others };
}

/** The view the overview carries; undefined until a board tick has read the board at least once. */
export function boardFromSnapshot(sessions: SessionSummary[], issues: IssueCost[]): BoardView | undefined {
  const last = snapshot();
  return last && cfg().configured ? buildBoardView(last, cfg().statusField.columns, sessions, issues) : undefined;
}
