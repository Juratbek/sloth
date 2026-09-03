import type { HoursEnding, HoursExcluded, HoursIssue, HoursKind, HoursLive } from '../../../server/types';
import { dayLabel, hrs } from '../../lib/format';

/** How a kind of run reads in a cell. */
export const KIND_LABEL: Record<HoursKind, string> = { issue: 'implement', approved: 'review', review: 'review', qa: 'QA' };
/** Why a run is not billed, in the words the excluded list shows. */
export const ENDING_LABEL: Record<HoursEnding, string> = {
  done: 'finished',
  waiting: 'asked a human',
  verdict: 'posted its verdict',
  died: 'died while working',
  budget: 'hung past its budget',
  usageLimit: 'usage limit',
  stopped: 'stopped from the monitor',
  rebooted: 'machine rebooted',
};

const issueLink = (repo: string, issue: number | undefined) =>
  issue ? (
    <a href={`https://github.com/${repo}/issues/${issue}`} target="_blank" rel="noreferrer" className="text-zinc-300 hover:underline">
      #{issue}
    </a>
  ) : (
    <span>—</span>
  );

const th = 'px-2 py-1 font-medium';

/** The month's billable hours, one row per card, most hours first. */
export function IssuesHours({ issues, repo }: { issues: HoursIssue[]; repo: string }) {
  return (
    <table className="w-full text-[11px]">
      <thead className="sticky top-0 bg-zinc-900 text-zinc-400">
        <tr>
          <th className={`${th} text-left`}>issue</th>
          <th className={`${th} hidden text-left sm:table-cell`}>title</th>
          <th className={`${th} text-right`}>runs</th>
          <th className={`${th} hidden text-right sm:table-cell`}>implement</th>
          <th className={`${th} hidden text-right sm:table-cell`}>review</th>
          <th className={`${th} hidden text-right sm:table-cell`}>QA</th>
          <th className={`${th} text-right`}>billable</th>
        </tr>
      </thead>
      <tbody className="text-zinc-400">
        {issues.map((i) => (
          <tr key={i.issue} className="border-t border-zinc-800/70">
            <td className="px-2 py-1 whitespace-nowrap">{issueLink(repo, i.issue)}</td>
            <td className="hidden max-w-0 truncate px-2 py-1 sm:table-cell">{i.title ?? ''}</td>
            <td className="px-2 py-1 text-right tabular-nums">{i.runs}</td>
            <td className="hidden px-2 py-1 text-right tabular-nums sm:table-cell">{i.byKind.issue ? hrs(i.byKind.issue) : '—'}</td>
            <td className="hidden px-2 py-1 text-right tabular-nums sm:table-cell">
              {(i.byKind.approved ?? 0) + (i.byKind.review ?? 0) ? hrs((i.byKind.approved ?? 0) + (i.byKind.review ?? 0)) : '—'}
            </td>
            <td className="hidden px-2 py-1 text-right tabular-nums sm:table-cell">{i.byKind.qa ? hrs(i.byKind.qa) : '—'}</td>
            <td className="px-2 py-1 text-right tabular-nums text-zinc-300" title={i.excludedSeconds ? `${hrs(i.excludedSeconds)} more in runs that failed — not billed` : undefined}>
              {hrs(i.seconds)}
              {i.excludedSeconds > 0 && <span className="text-zinc-500"> +{hrs(i.excludedSeconds)}</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The month's failed runs, each with the reason it is not on the bill. */
export function ExcludedRuns({ runs, repo }: { runs: HoursExcluded[]; repo: string }) {
  return (
    <ul className="space-y-0.5 px-2 py-1 text-[11px] text-zinc-500">
      {runs.map((r) => (
        <li key={r.n} className="flex flex-wrap gap-x-2">
          <span className="text-zinc-400">{issueLink(repo, r.issue)}</span>
          <span>{KIND_LABEL[r.kind]}</span>
          <span className="tabular-nums">{hrs(r.seconds)}</span>
          <span>{ENDING_LABEL[r.ending]}</span>
          <span className="tabular-nums">{dayLabel(new Date(r.endedAt * 1000).toISOString())}</span>
        </li>
      ))}
    </ul>
  );
}

/** The runs going right now — their hours join the month when they end. */
export function LiveRuns({ runs, repo }: { runs: HoursLive[]; repo: string }) {
  return (
    <span className="text-zinc-500">
      {' · running now: '}
      {runs.map((r, i) => (
        <span key={`${r.kind}-${r.target}`}>
          {i > 0 && ', '}
          {issueLink(repo, r.issue)} {KIND_LABEL[r.kind]} <span className="tabular-nums">{hrs(r.seconds)}</span>
        </span>
      ))}
    </span>
  );
}
