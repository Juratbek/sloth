import { cfg } from './config';
import { issueOf } from './issue-costs';
import { snapshot } from './runner/board-snapshot';
import { DONE_DAYS, PIPELINE, SKIP_LABEL, skipped } from './board-types';
import type { BlockedCard, BoardCard, BoardColumn, BoardView } from './board-types';
import { blockedCards } from './runner/blocked';
import type { BoardItem } from './runner/board';
import type { ColumnRole, ConfigColumns } from './config-types';
import { refKey } from './repo-types';
import type { IssueCost, SessionSummary } from './types';

/**
 * Joins the board Sloth last read to the runs it started on those cards, so the home panel can answer
 * "where is every card, and is Sloth on it?" without a request of its own. Kept apart from
 * `sessions.ts` so the join stays a pure function `test/board-view.test.ts` can call directly.
 */

const DONE_MS = DONE_DAYS * 86_400_000;

/**
 * What the loop knows and the board snapshot does not: the four reasons Sloth is starting nothing at
 * all just now. Handed in rather than read here, so `buildBoardView` stays a pure function a test can
 * call with any machine it likes; `sessions.ts` `overview()` gathers it from the modules that own each
 * piece (`runner/pause.ts`, `run-control.ts`, `runner/machine.ts`, `runner/session-dirs.ts`).
 */
export interface HoldState {
  /** The user's own pause — Sloth starts no new work while it is set. */
  paused?: boolean;
  /** Epoch seconds the usage-limit pause runs to; in the past or absent means none. */
  pausedUntil?: number;
  /** `machineHold()`: too little memory, CPU or disk left for another session. */
  machine?: string;
  /** `slotsFull()`: `maxActive` are working or `maxAlive` are alive. */
  slotsFull?: boolean;
  /** `maxRetries` — how many relaunches in a row a card gets before it is parked. */
  maxRetries?: number;
}

/**
 * Why this card is not being worked, in one sentence — the home panel's answer to "why is nothing
 * happening?", which until now only `watcher.log` had.
 *
 * Two kinds of reason. A card's own — a give-up, the skip label, a run parked for a human, the retries
 * used up — belongs to that card wherever it sits, and is asked about first because it is the more
 * useful answer: a paused Sloth is not why *this* card is blocked. The rest are the loop's, and apply
 * only where Sloth would otherwise be about to start something: the pickup queue and In Progress cards
 * with nobody on them. Everywhere else — Code Review, Approved, QA, Done — a card is waiting on a
 * verdict, a human or a merge, and "Sloth is paused" would be noise.
 *
 * A card a session is live on is being worked and has no hold, with one exception: a Code Review card
 * whose session has not finished closing down, where the live session *is* the reason the review has
 * not started (trigger 4 — one actor owns a card at a time). A card in Done is not waiting for
 * anything at all, so nothing there is a hold either.
 */
function holdOf(role: ColumnRole, item: BoardItem, s: SessionSummary | undefined, blocked: string | undefined, hold: HoldState, now: number): string | undefined {
  if (role === 'done') return undefined;
  if (s?.live) return role === 'codeReview' ? 'The review waits for the session on this issue to finish.' : undefined;
  if (blocked) return `Sloth has given up on this card — ${blocked} Unblock it from the home panel.`;
  if (s?.status === 'parked' || role === 'needsHelp') return 'Parked for a human: answer in the issue thread and Sloth carries on.';
  // A skipped card is reviewed all the same — the Code Review column is the signal there, not the label.
  if (skipped(item) && role !== 'codeReview') return `The ${SKIP_LABEL} label holds this card back — take it off and Sloth works it again.`;
  const retries = s?.watcher?.retries ?? 0;
  if (role === 'inProgress' && hold.maxRetries !== undefined && retries >= hold.maxRetries)
    return `${retries} runs in a row stopped without finishing — the next tick parks this card instead of relaunching it.`;
  if (role !== 'pickup' && role !== 'inProgress') return undefined;
  if (hold.pausedUntil && hold.pausedUntil * 1000 > now)
    return `Sloth hit a Claude usage limit and starts nothing new for another ${Math.ceil((hold.pausedUntil * 1000 - now) / 60_000)} min.`;
  if (hold.paused) return 'Sloth is paused — it starts no new work until you resume it.';
  if (hold.machine) return `The machine is busy (${hold.machine.replace(/^machine busy: /, '')}) — no new session until that clears.`;
  if (hold.slotsFull) return 'Every session slot is taken; this card starts as soon as one frees up.';
  return undefined;
}

/**
 * The newest run per issue. An implement run is named after its issue; a review is
 * named after the PR and carries the issue beside it (`issueOf`), so a review that started after the
 * implement run is the one the card shows.
 */
function newestByIssue(sessions: SessionSummary[]): Map<string, SessionSummary> {
  const out = new Map<string, SessionSummary>();
  for (const s of sessions) {
    const issue = issueOf(s);
    if (!issue) continue;
    const key = refKey(issue);
    const seen = out.get(key);
    if (!seen || (s.startedAt ?? '') > (seen.startedAt ?? '')) out.set(key, s);
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

function cardOf(item: BoardItem, s: SessionSummary | undefined, cost: number | null, blocked: string | undefined, hold: string | undefined): BoardCard {
  const w = s?.watcher;
  const preview = w?.preview;
  // "Waiting since" only means something while the run is actually waiting for an answer.
  const held = s?.status === 'parked' || s?.status === 'waiting';
  return {
    repo: item.repo,
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
    blocked,
    hold,
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
  blocked: BlockedCard[] = [],
  now = Date.now(),
  hold: HoldState = {},
): BoardView {
  const newest = newestByIssue(sessions);
  const costs = new Map(issues.map((i) => [refKey({ repo: i.repo, number: i.issue }), i.cost]));
  const blocks = new Map(blocked.map((b) => [refKey({ repo: b.repo, number: b.issue }), b.reason]));
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
    const key = refKey(item);
    const s = newest.get(key);
    if (!sloths(column.role, item, s)) {
      others++;
      continue;
    }
    if (column.role === 'done' && s && !recent(s, now)) continue;
    const reason = blocks.get(key);
    column.cards.push(cardOf(item, s, costs.get(key) ?? null, reason, holdOf(column.role, item, s, reason, hold, now)));
  }
  return { asOf: new Date(board.at).toISOString(), columns: out, elsewhere, others };
}

/**
 * The view the overview carries; undefined until a board tick has read the board at least once. `hold`
 * is the loop state the per-card reasons need, which only the caller can see (`sessions.ts`).
 */
export function boardFromSnapshot(sessions: SessionSummary[], issues: IssueCost[], hold: HoldState = {}): BoardView | undefined {
  const last = snapshot();
  return last && cfg().configured ? buildBoardView(last, cfg().statusField.columns, sessions, issues, blockedCards(), Date.now(), hold) : undefined;
}
