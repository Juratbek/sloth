/**
 * The hours ledger — what Sloth bills a project by. One entry per run that ended, written by the server
 * alone (`runner/hours.ts`) into an append-only file whose lines fingerprint one another, and copied to
 * the watched repository's `sloth-assets` branch (`runner/hours-copy.ts`). Split out of `types.ts`,
 * which re-exports it.
 */

/**
 * How a run ended, as the ledger records it. The first three are work the run finished: it reached
 * `done`, it stopped to ask a human (`waiting`), or a review / QA run posted its verdict on the PR. The
 * rest are failures: it died while still `working`, Sloth killed it for hanging past its budget, a Claude
 * usage limit stopped it, a human stopped it from the monitor, or the machine rebooted under it. A failed
 * run's hours are billed at `CONTINUED_RATE` once a later session takes its card up — its work was taken
 * over, not lost — and not at all otherwise (`hours.ts`).
 */
export type HoursEnding = 'done' | 'waiting' | 'verdict' | 'died' | 'budget' | 'usageLimit' | 'stopped' | 'rebooted';
export const BILLABLE_ENDINGS: readonly HoursEnding[] = ['done', 'waiting', 'verdict'];
export const billable = (ending: HoursEnding): boolean => BILLABLE_ENDINGS.includes(ending);
/** What a continued run's hours are worth on the invoice, as a fraction of a billable hour: the 50% discount. */
export const CONTINUED_RATE = 0.5;

/** The run kinds the ledger books — every kind that works a board card; a status reply is not a run. */
export type HoursKind = 'issue' | 'approved' | 'review' | 'qa';

/** One line of the ledger. `hash` fingerprints the line's own text, `prev` the line before it. */
export interface HoursEntry {
  /** 1-based position in the ledger; a gap is a removed line. */
  n: number;
  kind: HoursKind;
  target: number;
  /** The issue the run worked for; a review names its PR in `target`, and the issue beside it here. */
  issue?: number;
  sessionId?: string;
  /** Epoch seconds: launched, ended, and how long it stood paused for the machine in between. */
  startedAt: number;
  endedAt: number;
  pausedSeconds: number;
  /** `endedAt - startedAt - pausedSeconds`, never below zero: the run's own session-seconds. */
  seconds: number;
  ending: HoursEnding;
  billable: boolean;
  prev: string;
  hash: string;
}

/** A card's hours in the month shown: billable runs, the failed runs a later session continued (discounted), and the rest (not billed). */
export interface HoursIssue {
  issue: number;
  title?: string;
  seconds: number;
  runs: number;
  byKind: Partial<Record<HoursKind, number>>;
  continuedSeconds: number;
  excludedSeconds: number;
  lastAt: number;
}
/** A failed run in the month shown, with why it failed; `continued` when a later session took its card up, so it is billed at `CONTINUED_RATE`. */
export interface HoursExcluded {
  n: number;
  kind: HoursKind;
  target: number;
  issue?: number;
  seconds: number;
  ending: HoursEnding;
  endedAt: number;
  continued: boolean;
}
/** One month's totals — the month picker's list. */
export interface HoursMonth {
  /** `YYYY-MM`, UTC. */
  month: string;
  billableSeconds: number;
  continuedSeconds: number;
  excludedSeconds: number;
  runs: number;
}
/** A run still going: its seconds so far, booked only once it ends. */
export interface HoursLive {
  kind: HoursKind;
  target: number;
  issue?: number;
  seconds: number;
}

/**
 * Whether the record can be trusted. `chain` is the local file's fingerprints, checked on every read;
 * `copy` is the branch in the watched repository against the local file, checked by the tick
 * (`runner/hours-copy.ts`) — `behind` is the normal state between a run ending and its push.
 */
export interface HoursIntegrity {
  chain: 'ok' | 'broken';
  copy: 'ok' | 'behind' | 'diverged' | 'unreachable' | 'unchecked';
  /** What is wrong, in one line, when either is not `ok`. */
  problem?: string;
  /** When the copy was last compared. */
  checkedAt?: number;
}

export interface HoursReport {
  /** The month shown, `YYYY-MM` UTC. */
  month: string;
  months: HoursMonth[];
  billableSeconds: number;
  /** Hours of failed runs a later session continued — worth `CONTINUED_RATE` of a billable hour each. */
  continuedSeconds: number;
  excludedSeconds: number;
  runs: number;
  issues: HoursIssue[];
  excluded: HoursExcluded[];
  live: HoursLive[];
  /** Billable seconds over the whole ledger, and the continued ones beside them. */
  totalSeconds: number;
  totalContinuedSeconds: number;
  /** When the ledger began — the first entry's end; absent while it is empty. */
  since?: number;
  integrity: HoursIntegrity;
}
