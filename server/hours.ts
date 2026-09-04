import type { HoursEntry, HoursExcluded, HoursIssue, HoursLive, HoursMonth, HoursReport } from './hours-types';
import { issueOfRun, readLedger, runSeconds } from './runner/hours';
import { copyStatus } from './runner/hours-copy';
import { nowSec } from './runner/log';
import { dirAlive, runDirs } from './runner/session-dirs';
import { rateLimit, titleFor } from './watcher';

/**
 * The hours report the home panel shows and `/api/hours` serves: one month of the ledger, billable hours
 * by issue, the failed runs listed with how they ended, and the runs still going. Hours only — the rate
 * is the invoice's business, not Sloth's. Months are UTC, so an invoice reads the same wherever it is read.
 *
 * A failed run is in one of two places. When a later run took its work up, its hours are **continued**:
 * they went into work that went on, and the invoice charges them at half rate; they are summed apart from
 * the billable hours so the invoice can. When nobody took the work up they are **excluded**: booked with
 * their reason, billed nothing. Taking up means a *billable* run on the same issue, started within
 * `CONTINUE_DAYS` of the failure, that did not start over (`fresh`: a pickup, a QA fail). A failure
 * followed only by more failures is charged nothing — the work never reached the client — and a run still
 * going counts for nothing until it is booked, since it may yet fail too. Which of the two a run is depends
 * on what came after it, so it is decided here at read time, never written into the line; the window is
 * what makes a month's figures final once it has passed.
 */

/** How long after a failure a billable run on the same issue still counts as taking its work up. */
export const CONTINUE_DAYS = 30;

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const monthOf = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 7);
/** `YYYY-MM` of now, or of the argument when it is one. */
export const monthArg = (wanted: string | null | undefined): string => (wanted && MONTH.test(wanted) ? wanted : monthOf(nowSec()));

/** The failed entries a later billable run took up, by their line number. */
function continuedLines(entries: HoursEntry[]): Set<number> {
  const out = new Set<number>();
  const window = CONTINUE_DAYS * 24 * 3600;
  for (const [i, e] of entries.entries()) {
    if (e.billable || !e.issue) continue;
    const takenUp = entries.slice(i + 1).some((later) => later.issue === e.issue && later.billable && !later.fresh && later.startedAt >= e.endedAt && later.startedAt <= e.endedAt + window);
    if (takenUp) out.add(e.n);
  }
  return out;
}

/** Every month the ledger has an entry in, newest first. */
function months(entries: HoursEntry[], continued: Set<number>): HoursMonth[] {
  const out = new Map<string, HoursMonth>();
  for (const e of entries) {
    const month = monthOf(e.endedAt);
    const m = out.get(month) ?? { month, billableSeconds: 0, continuedSeconds: 0, excludedSeconds: 0, runs: 0 };
    m.runs++;
    if (e.billable) m.billableSeconds += e.seconds;
    else if (continued.has(e.n)) m.continuedSeconds += e.seconds;
    else m.excludedSeconds += e.seconds;
    out.set(month, m);
  }
  return [...out.values()].sort((a, b) => b.month.localeCompare(a.month));
}

/** The month's runs by issue, most billable hours first; a run with no issue is booked under 0. */
function byIssue(entries: HoursEntry[], continued: Set<number>, titleOf: (issue: number) => string | undefined): HoursIssue[] {
  const out = new Map<number, HoursIssue>();
  for (const e of entries) {
    const issue = e.issue ?? 0;
    const row = out.get(issue) ?? { issue, title: issue ? titleOf(issue) : undefined, seconds: 0, runs: 0, byKind: {}, continuedSeconds: 0, excludedSeconds: 0, lastAt: 0 };
    if (e.billable) {
      row.seconds += e.seconds;
      row.runs++;
      row.byKind[e.kind] = (row.byKind[e.kind] ?? 0) + e.seconds;
    } else if (continued.has(e.n)) row.continuedSeconds += e.seconds;
    else row.excludedSeconds += e.seconds;
    row.lastAt = Math.max(row.lastAt, e.endedAt);
    out.set(issue, row);
  }
  return [...out.values()].sort((a, b) => b.seconds - a.seconds || b.continuedSeconds - a.continuedSeconds || b.lastAt - a.lastAt);
}

const failedOf = (entries: HoursEntry[], continued: Set<number>): HoursExcluded[] =>
  entries
    .filter((e) => !e.billable)
    .map(({ n, kind, target, issue, seconds, ending, endedAt }) => ({ n, kind, target, issue, seconds, ending, endedAt, continued: continued.has(n) }))
    .sort((a, b) => b.endedAt - a.endedAt);

/** The runs alive right now and their seconds so far — booked when they end, shown meanwhile. */
function live(): HoursLive[] {
  const now = nowSec();
  return runDirs()
    .filter((d) => dirAlive(d.dir))
    .map(({ kind, target, dir }) => ({ kind, target, issue: issueOfRun(kind, target, dir), seconds: runSeconds(dir, now) }))
    .sort((a, b) => b.seconds - a.seconds);
}

export async function hoursReport(wanted?: string | null): Promise<HoursReport> {
  const month = monthArg(wanted);
  // Titles are fetched one call each, like the overview's — and only while the REST bucket has room.
  const coreRemaining = (await rateLimit())?.core?.remaining;
  const { entries, problem } = readLedger();
  const alive = live();
  const continued = continuedLines(entries);
  const shown = entries.filter((e) => monthOf(e.endedAt) === month);
  const copy = copyStatus();
  const sum = (list: HoursEntry[], of: (e: HoursEntry) => boolean) => list.reduce((n, e) => (of(e) ? n + e.seconds : n), 0);
  const isBillable = (e: HoursEntry) => e.billable;
  const isContinued = (e: HoursEntry) => !e.billable && continued.has(e.n);
  const isExcluded = (e: HoursEntry) => !e.billable && !continued.has(e.n);
  return {
    month,
    months: months(entries, continued),
    billableSeconds: sum(shown, isBillable),
    continuedSeconds: sum(shown, isContinued),
    excludedSeconds: sum(shown, isExcluded),
    runs: shown.length,
    issues: byIssue(shown, continued, (n) => titleFor(n, coreRemaining)),
    excluded: failedOf(shown, continued),
    live: alive,
    totalSeconds: sum(entries, isBillable),
    totalContinuedSeconds: sum(entries, isContinued),
    since: entries[0]?.endedAt,
    integrity: {
      chain: problem ? 'broken' : 'ok',
      copy: copy.copy,
      problem: problem ?? (copy.copy === 'diverged' || copy.copy === 'unreachable' ? copy.problem : undefined),
      checkedAt: copy.checkedAt,
    },
  };
}
