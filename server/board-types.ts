/**
 * The home panel's mirror of the GitHub board: Sloth's six columns in pipeline order, the cards on
 * them, and what Sloth's newest run on each card is doing. It is a *mirror* — the view is built from
 * the board the loop already read (`runner/board-snapshot.ts`), never from a fetch of its own, and
 * nothing in the UI writes back to GitHub.
 */
import type { ColumnRole } from './config-types';
import type { SessionStatus, WatcherSession } from './types';

/**
 * The label `/sloth:review <pr> final` puts on an issue whose PR passed. It lives here, and not in
 * `runner/markers.ts` (which re-exports it), because an Approved card renders a badge for it and the
 * UI cannot import a module that reaches for `node:fs`.
 */
export const APPROVED_LABEL = 'Fable: approved';

/**
 * The label a person puts on an issue to keep Sloth off it: a card carrying it is a human's, in any
 * column, and Sloth neither picks it up, relaunches it nor fixes its checks. The one exception is the
 * review in Code Review — the column is the signal there. Sloth creates the label
 * in the repo at start-up (`ensureSkipLabel`) so it is there to apply.
 */
export const SKIP_LABEL = 'Sloth: skip';

/** Whether a card is held back from Sloth by `SKIP_LABEL`. */
export const skipped = (item: { labels: string[] }): boolean => item.labels.includes(SKIP_LABEL);

/** Sloth's columns, always in this order — the pipeline, not the order the GitHub board happens to be in. */
export const PIPELINE: ColumnRole[] = ['pickup', 'inProgress', 'needsHelp', 'codeReview', 'approved', 'done'];

/** How far back Done looks. A closed card older than this is archive, not this week's work. */
export const DONE_DAYS = 7;

/**
 * One card: the issue as the board has it, plus the newest run Sloth made on that issue. Only Sloth's
 * cards are on the view — the ones it has run on, and the unclaimed ones waiting in pickup.
 */
export interface BoardCard {
  issue: number;
  title: string;
  /** Shown on the card; an assignee does not keep Sloth off it — `SKIP_LABEL` among `labels` does. */
  assignees: string[];
  labels: string[];
  closed: boolean;
  /** The transcript of the newest run on this issue — what clicking the card selects. Absent: still waiting in pickup. */
  sessionId?: string;
  status?: SessionStatus;
  /** That run's raw step from `state.json`; the UI turns it into words (`stepLabel`). */
  step?: string;
  /** Which kind of run it was — `stepLabel` reads a different list per kind. */
  kind?: WatcherSession['kind'];
  /** Epoch seconds the run has been parked or waiting since; absent when it is neither. */
  since?: number;
  retries: number;
  /** The PR the run opened, as its `state.json` has it. */
  pr?: string;
  /** The run's app, live behind a tunnel; the link is `${url}/?sloth_key=${key}`, as the PR comment has it. */
  preview?: { url: string; key: string };
  /** What the issue has cost so far (the per-issue rollup); null when unpriced, or when nothing ran on it. */
  cost: number | null;
}

export interface BoardColumn {
  role: ColumnRole;
  id: string;
  name: string;
  cards: BoardCard[];
}

export interface BoardView {
  /** When the board was last read — the snapshot the last board tick left behind. */
  asOf: string;
  /** Sloth's columns in `PIPELINE` order; a role the config leaves blank is simply absent. */
  columns: BoardColumn[];
  /** Cards on Status options Sloth has no role for — counted, not listed. */
  elsewhere: number;
  /** Cards on Sloth's columns that are not Sloth's — no run on them and not waiting in pickup; a person's work, counted, not listed. */
  others: number;
}
