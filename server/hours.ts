import type { HoursEntry, HoursExcluded, HoursIssue, HoursLive, HoursMonth, HoursReport } from './hours-types';
import { issueOfRun, readLedger, runSeconds } from './runner/hours';
import { copyStatus } from './runner/hours-copy';
import { nowSec } from './runner/log';
import { dirAlive, runDirs } from './runner/session-dirs';
import { rateLimit, titleFor } from './watcher';

/**
 * The hours report the home panel shows and `/api/hours` serves: one month of the ledger, billable
 * hours by issue, the failed runs listed with their reason — continued by a later session (discounted) or
 * not (not billed) — and the runs still going.
 * Hours only — the rate is the invoice's business, not Sloth's. Months are UTC, so an invoice reads the
 * same wherever it is read.
 */

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const monthOf = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 7);
/** `YYYY-MM` of now, or of the argument when it is one. */
export const monthArg = (wanted: string | null | undefined): string => (wanted && MONTH.test(wanted) ? wanted : monthOf(nowSec()));

/** Billable, continued or excluded: how a run's seconds land on the bill. */
type Bucket = 'billable' | 'continued' | 'excluded';

/**
 * Which bucket each run falls in, judged over the whole ledger: a failed run is `continued` the moment a
 * later session takes its card up — one booked after it, or one running now — since its work was taken
 * over rather than lost. Whatever the failure was: the connection, the machine, the budget, a stop. The
 * month it is counted in is its own, even when the continuation came the month after.
 */
function buckets(entries: HoursEntry[], running: HoursLive[]): Map<number, Bucket> {
  const out = new Map<number, Bucket>();
  const takenUp = (e: HoursEntry) => entries.some((later) => later.n > e.n && later.issue === e.issue) || running.some((r) => r.issue === e.issue);
  for (const e of entries) out.set(e.n, e.billable ? 'billable' : e.issue && takenUp(e) ? 'continued' : 'excluded');
  return out;
}

/** Every month the ledger has an entry in, newest first. */
function months(entries: HoursEntry[], bucket: Map<number, Bucket>): HoursMonth[] {
  const out = new Map<string, HoursMonth>();
  for (const e of entries) {
    const month = monthOf(e.endedAt);
    const m = out.get(month) ?? { month, billableSeconds: 0, continuedSeconds: 0, excludedSeconds: 0, runs: 0 };
    m.runs++;
    if (bucket.get(e.n) === 'billable') m.billableSeconds += e.seconds;
    else if (bucket.get(e.n) === 'continued') m.continuedSeconds += e.seconds;
    else m.excludedSeconds += e.seconds;
    out.set(month, m);
  }
  return [...out.values()].sort((a, b) => b.month.localeCompare(a.month));
}

/** The month's billable runs by issue, most hours first; a run with no issue is booked under 0. */
function byIssue(entries: HoursEntry[], bucket: Map<number, Bucket>, titleOf: (issue: number) => string | undefined): HoursIssue[] {
  const out = new Map<number, HoursIssue>();
  for (const e of entries) {
    const issue = e.issue ?? 0;
    const row = out.get(issue) ?? { issue, title: issue ? titleOf(issue) : undefined, seconds: 0, runs: 0, byKind: {}, continuedSeconds: 0, excludedSeconds: 0, lastAt: 0 };
    if (bucket.get(e.n) === 'billable') {
      row.seconds += e.seconds;
      row.runs++;
      row.byKind[e.kind] = (row.byKind[e.kind] ?? 0) + e.seconds;
    } else if (bucket.get(e.n) === 'continued') row.continuedSeconds += e.seconds;
    else row.excludedSeconds += e.seconds;
    row.lastAt = Math.max(row.lastAt, e.endedAt);
    out.set(issue, row);
  }
  return [...out.values()].sort((a, b) => b.seconds - a.seconds || b.lastAt - a.lastAt || a.issue - b.issue);
}

const excludedOf = (entries: HoursEntry[], bucket: Map<number, Bucket>): HoursExcluded[] =>
  entries
    .filter((e) => !e.billable)
    .map(({ n, kind, target, issue, seconds, ending, endedAt }) => ({ n, kind, target, issue, seconds, ending, endedAt, continued: bucket.get(n) === 'continued' }))
    .sort((a, b) => b.endedAt - a.endedAt || b.n - a.n);

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
  const shown = entries.filter((e) => monthOf(e.endedAt) === month);
  const running = live();
  const bucket = buckets(entries, running);
  const copy = copyStatus();
  const sum = (list: HoursEntry[], which: Bucket) => list.reduce((n, e) => (bucket.get(e.n) === which ? n + e.seconds : n), 0);
  return {
    month,
    months: months(entries, bucket),
    billableSeconds: sum(shown, 'billable'),
    continuedSeconds: sum(shown, 'continued'),
    excludedSeconds: sum(shown, 'excluded'),
    runs: shown.length,
    issues: byIssue(shown, bucket, (n) => titleFor(n, coreRemaining)),
    excluded: excludedOf(shown, bucket),
    live: running,
    totalSeconds: sum(entries, 'billable'),
    totalContinuedSeconds: sum(entries, 'continued'),
    since: entries[0]?.endedAt,
    integrity: {
      chain: problem ? 'broken' : 'ok',
      copy: copy.copy,
      problem: problem ?? (copy.copy === 'diverged' || copy.copy === 'unreachable' ? copy.problem : undefined),
      checkedAt: copy.checkedAt,
    },
  };
}
