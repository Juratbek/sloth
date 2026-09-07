import { useState } from 'react';
import type { HoursReport } from '../../../server/types';
import useHours from '../../hooks/use-hours';
import { dayLabel, hrs } from '../../lib/format';
import Button from '../ui/Button';
import Chip from '../ui/Chip';
import ErrorNote from '../ui/ErrorNote';
import { ExcludedRuns, IssuesHours, LiveRuns } from './HoursTable';

/**
 * The hours a project is billed by: one month of the ledger the server keeps (`server/runner/hours.ts`),
 * billable session-hours as the headline, a row per card, and the failed runs that are not on the bill
 * under it with their reasons. Hours, never money — the rate is the invoice's business. The chip at the
 * end says whether the record can be trusted: its own chain of fingerprints, and its copy on the
 * assets branch of the repository.
 */

/** `YYYY-MM` moved by `by` calendar months, in UTC like the server's buckets. */
export function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return d.toISOString().slice(0, 7);
}
const monthLabel = (month: string) => new Date(`${month}-01T00:00:00Z`).toLocaleDateString([], { month: 'long', year: 'numeric', timeZone: 'UTC' });

function Integrity({ report }: { report: HoursReport }) {
  const { chain, copy, problem, checkedAt } = report.integrity;
  const at = checkedAt ? `checked ${dayLabel(new Date(checkedAt * 1000).toISOString())}` : 'not compared yet';
  if (chain === 'broken' || copy === 'diverged') return <Chip tone="red" size="xs" title={problem}>ledger tampered</Chip>;
  if (copy === 'unreachable') return <Chip tone="amber" size="xs" title={problem}>copy unreachable</Chip>;
  if (copy === 'behind') return <Chip tone="amber" size="xs" title={`the copy on the assets branch is behind — pushed with the next tick · ${at}`}>copy pending</Chip>;
  if (copy === 'unchecked') return <Chip tone="zinc" size="xs" title={at}>copy unchecked</Chip>;
  return <Chip tone="emerald" size="xs" title={`the ledger checks out and matches its copy on the assets branch · ${at}`}>ledger intact</Chip>;
}

export default function HoursPanel({ repo, several = false }: { repo: string; several?: boolean }) {
  // Empty asks the server for this month; the arrows move from whatever month it answered with.
  const [month, setMonth] = useState('');
  const { data: report, error } = useHours(month);
  const heading = <h3 className="text-[10px] font-semibold tracking-wide text-zinc-400 uppercase">hours</h3>;
  if (error) {
    return (
      <section className="shrink-0 space-y-1">
        {heading}
        <ErrorNote error={error} />
      </section>
    );
  }
  if (!report) return <section className="shrink-0 space-y-1">{heading}</section>;
  const shown = report.month;
  const thisMonth = new Date().toISOString().slice(0, 7);
  return (
    <section className="flex max-h-72 shrink-0 flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        {heading}
        <Button variant="icon" size="inline" aria-label="previous month" onClick={() => setMonth(shiftMonth(shown, -1))}>
          ‹
        </Button>
        <span className="text-[11px] text-zinc-300">{monthLabel(shown)}</span>
        <Button variant="icon" size="inline" aria-label="next month" disabled={shown >= thisMonth} onClick={() => setMonth(shiftMonth(shown, 1))}>
          ›
        </Button>
        <span className="text-[11px] text-zinc-500">
          <span className="text-zinc-200 tabular-nums">{hrs(report.billableSeconds)}</span> billable
          {report.continuedSeconds > 0 && (
            <>
              {' · '}
              <span className="text-amber-400/80 tabular-nums" title="failed runs a later run took up — charged at half rate">
                {hrs(report.continuedSeconds)}
              </span>{' '}
              continued at half rate
            </>
          )}
          {report.excludedSeconds > 0 && (
            <>
              {' · '}
              <span className="tabular-nums">{hrs(report.excludedSeconds)}</span> in failed runs, not billed
            </>
          )}
          {' · '}
          <span className="tabular-nums">{hrs(report.totalSeconds)}</span>
          {report.totalContinuedSeconds > 0 ? ` + ${hrs(report.totalContinuedSeconds)} continued` : ''} all time
          {report.since ? ` since ${dayLabel(new Date(report.since * 1000).toISOString())}` : ''}
          {report.live.length > 0 && <LiveRuns runs={report.live} repo={repo} several={several} />}
        </span>
        <span className="ml-auto">
          <Integrity report={report} />
        </span>
      </div>
      {report.runs === 0 ? (
        <p className="rounded-md border border-zinc-800 p-3 text-[11px] text-zinc-400">
          No run ended in {monthLabel(shown)}. A run is booked here the moment it ends; the ledger began with this version of Sloth.
        </p>
      ) : (
        <div className="min-h-0 overflow-auto rounded-md border border-zinc-800">
          {report.issues.length > 0 && <IssuesHours issues={report.issues} repo={repo} several={several} />}
          {report.excluded.length > 0 && (
            <details className="border-t border-zinc-800/70">
              <summary className="cursor-pointer px-2 py-1 text-[11px] text-zinc-500">
                {report.excluded.length} failed run{report.excluded.length === 1 ? '' : 's'}
              </summary>
              <ExcludedRuns runs={report.excluded} repo={repo} several={several} />
            </details>
          )}
        </div>
      )}
    </section>
  );
}
