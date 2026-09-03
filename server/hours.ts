import type { HoursEntry, HoursExcluded, HoursIssue, HoursLive, HoursMonth, HoursReport } from './hours-types';
import { issueOfRun, readLedger, runSeconds } from './runner/hours';
import { copyStatus } from './runner/hours-copy';
import { nowSec } from './runner/log';
import { dirAlive, runDirs } from './runner/session-dirs';
import { rateLimit, titleFor } from './watcher';

/**
 * The hours report the home panel shows and `/api/hours` serves: one month of the ledger, billable
 * hours by issue, the failed runs that are not billed listed with their reason, and the runs still going.
 * Hours only — the rate is the invoice's business, not Sloth's. Months are UTC, so an invoice reads the
 * same wherever it is read.
 */

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const monthOf = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 7);
/** `YYYY-MM` of now, or of the argument when it is one. */
export const monthArg = (wanted: string | null | undefined): string => (wanted && MONTH.test(wanted) ? wanted : monthOf(nowSec()));

/** Every month the ledger has an entry in, newest first. */
function months(entries: HoursEntry[]): HoursMonth[] {
  const out = new Map<string, HoursMonth>();
  for (const e of entries) {
    const month = monthOf(e.endedAt);
    const m = out.get(month) ?? { month, billableSeconds: 0, excludedSeconds: 0, runs: 0 };
    m.runs++;
    if (e.billable) m.billableSeconds += e.seconds;
    else m.excludedSeconds += e.seconds;
    out.set(month, m);
  }
  return [...out.values()].sort((a, b) => b.month.localeCompare(a.month));
}

/** The month's billable runs by issue, most hours first; a run with no issue is booked under 0. */
function byIssue(entries: HoursEntry[], titleOf: (issue: number) => string | undefined): HoursIssue[] {
  const out = new Map<number, HoursIssue>();
  for (const e of entries) {
    const issue = e.issue ?? 0;
    const row = out.get(issue) ?? { issue, title: issue ? titleOf(issue) : undefined, seconds: 0, runs: 0, byKind: {}, excludedSeconds: 0, lastAt: 0 };
    if (e.billable) {
      row.seconds += e.seconds;
      row.runs++;
      row.byKind[e.kind] = (row.byKind[e.kind] ?? 0) + e.seconds;
    } else row.excludedSeconds += e.seconds;
    row.lastAt = Math.max(row.lastAt, e.endedAt);
    out.set(issue, row);
  }
  return [...out.values()].sort((a, b) => b.seconds - a.seconds || b.lastAt - a.lastAt);
}

const excludedOf = (entries: HoursEntry[]): HoursExcluded[] =>
  entries
    .filter((e) => !e.billable)
    .map(({ n, kind, target, issue, seconds, ending, endedAt }) => ({ n, kind, target, issue, seconds, ending, endedAt }))
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
  const shown = entries.filter((e) => monthOf(e.endedAt) === month);
  const copy = copyStatus();
  const sum = (list: HoursEntry[], billable: boolean) => list.reduce((n, e) => (e.billable === billable ? n + e.seconds : n), 0);
  return {
    month,
    months: months(entries),
    billableSeconds: sum(shown, true),
    excludedSeconds: sum(shown, false),
    runs: shown.length,
    issues: byIssue(shown, (n) => titleFor(n, coreRemaining)),
    excluded: excludedOf(shown),
    live: live(),
    totalSeconds: sum(entries, true),
    since: entries[0]?.endedAt,
    integrity: {
      chain: problem ? 'broken' : 'ok',
      copy: copy.copy,
      problem: problem ?? (copy.copy === 'diverged' || copy.copy === 'unreachable' ? copy.problem : undefined),
      checkedAt: copy.checkedAt,
    },
  };
}
