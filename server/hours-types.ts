/**
 * The hours ledger — what Sloth bills a project by. One entry per run that ended, written by the server
 * alone (`runner/hours.ts`) into an append-only file whose lines fingerprint one another, and copied to
 * the watched repository's `sloth-assets` branch (`runner/hours-copy.ts`). Split out of `types.ts`,
 * which re-exports it.
 */

/**
 * How a run ended, as the ledger records it. The first three are work the run finished: it reached
 * `done`, it stopped to ask a human (`waiting`), or a review / QA run posted its verdict on the PR. The
 * rest are failures nobody should pay for: it died while still `working`, Sloth killed it for hanging past
 * its budget, a Claude usage limit stopped it, a human stopped it from the monitor, or the machine
 * rebooted under it.
 */
export type HoursEnding = 'done' | 'waiting' | 'verdict' | 'died' | 'budget' | 'usageLimit' | 'stopped' | 'rebooted';
export const BILLABLE_ENDINGS: readonly HoursEnding[] = ['done', 'waiting', 'verdict'];
export const billable = (ending: HoursEnding): boolean => BILLABLE_ENDINGS.includes(ending);

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
  /**
   * Epoch seconds: launched, ended, and how long in between it stood paused for the machine, or parked
   * in needs-help waiting for an answer (`runner/waiting.ts`) — neither is time the run worked.
   */
  startedAt: number;
  endedAt: number;
  pausedSeconds: number;
  waitedSeconds: number;
  /** `endedAt - startedAt - pausedSeconds - waitedSeconds`, never below zero: the run's own session-seconds. */
  seconds: number;
  ending: HoursEnding;
  billable: boolean;
  prev: string;
  hash: string;
}

/** A card's hours in the month shown, billable runs only; `excludedSeconds` is what its failed runs took. */
export interface HoursIssue {
  issue: number;
  title?: string;
  seconds: number;
  runs: number;
  byKind: Partial<Record<HoursKind, number>>;
  excludedSeconds: number;
  lastAt: number;
}
/** A failed run in the month shown, with the reason it is not billed. */
export interface HoursExcluded {
  n: number;
  kind: HoursKind;
  target: number;
  issue?: number;
  seconds: number;
  ending: HoursEnding;
  endedAt: number;
}
/** One month's totals — the month picker's list. */
export interface HoursMonth {
  /** `YYYY-MM`, UTC. */
  month: string;
  billableSeconds: number;
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
  excludedSeconds: number;
  runs: number;
  issues: HoursIssue[];
  excluded: HoursExcluded[];
  live: HoursLive[];
  /** Billable seconds over the whole ledger. */
  totalSeconds: number;
  /** When the ledger began — the first entry's end; absent while it is empty. */
  since?: number;
  integrity: HoursIntegrity;
}
