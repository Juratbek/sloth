import type { HoursEnding, HoursExcluded, HoursIssue, HoursKind, HoursLive } from '../../../server/types';
import { dayLabel, hrs, issueLabel } from '../../lib/format';

/** How a kind of run reads in a cell. */
export const KIND_LABEL: Record<HoursKind, string> = { issue: 'implement', approved: 'review', review: 'review', qa: 'QA', smoke: 'smoke test' };
/** How a run ended, in the words the failed-runs list shows. */
export const ENDING_LABEL: Record<HoursEnding, string> = {
  done: 'finished',
  waiting: 'asked a human',
  noResponse: 'out of response',
  verdict: 'posted its verdict',
  died: 'died while working',
  budget: 'hung past its budget',
  usageLimit: 'usage limit',
  stopped: 'stopped from the monitor',
  rebooted: 'machine rebooted',
};

/** `repo` is the row's own repository when it says one — a line from before Sloth watched several says none, and is the first repository's. */
const issueLink = (repo: string, issue: number | undefined, several = false) =>
  issue ? (
    <a href={`https://github.com/${repo}/issues/${issue}`} target="_blank" rel="noreferrer" className="text-zinc-300 hover:underline">
      {issueLabel(repo, issue, several)}
    </a>
  ) : (
    <span>—</span>
  );

const th = 'px-2 py-1 font-medium';

/** What a card's failed runs add up to, for the hover on its billable cell. */
function failedTitle(i: HoursIssue): string | undefined {
  const parts = [
    i.continuedSeconds ? `${hrs(i.continuedSeconds)} in failed runs a later run took up — half rate` : '',
    i.excludedSeconds ? `${hrs(i.excludedSeconds)} in failed runs nobody took up — not billed` : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : undefined;
}

/** The month's billable hours, one row per card, most hours first. */
export function IssuesHours({ issues, repo, several = false }: { issues: HoursIssue[]; repo: string; several?: boolean }) {
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
          <tr key={`${i.repo}#${i.issue}`} className="border-t border-zinc-800/70">
            <td className="px-2 py-1 whitespace-nowrap">{issueLink(i.repo || repo, i.issue, several)}</td>
            <td className="hidden max-w-0 truncate px-2 py-1 sm:table-cell">{i.title ?? ''}</td>
            <td className="px-2 py-1 text-right tabular-nums">{i.runs}</td>
            <td className="hidden px-2 py-1 text-right tabular-nums sm:table-cell">{i.byKind.issue ? hrs(i.byKind.issue) : '—'}</td>
            <td className="hidden px-2 py-1 text-right tabular-nums sm:table-cell">
              {(i.byKind.approved ?? 0) + (i.byKind.review ?? 0) ? hrs((i.byKind.approved ?? 0) + (i.byKind.review ?? 0)) : '—'}
            </td>
            <td className="hidden px-2 py-1 text-right tabular-nums sm:table-cell">{i.byKind.qa ? hrs(i.byKind.qa) : '—'}</td>
            <td className="px-2 py-1 text-right tabular-nums text-zinc-300" title={failedTitle(i)}>
              {hrs(i.seconds)}
              {i.continuedSeconds > 0 && <span className="text-amber-400/80"> +{hrs(i.continuedSeconds)}</span>}
              {i.excludedSeconds > 0 && <span className="text-zinc-500"> +{hrs(i.excludedSeconds)}</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The month's failed runs: how each ended, and whether a later run took its card up (half rate) or not (not billed). */
export function ExcludedRuns({ runs, repo, several = false }: { runs: HoursExcluded[]; repo: string; several?: boolean }) {
  return (
    <ul className="space-y-0.5 px-2 py-1 text-[11px] text-zinc-500">
      {runs.map((r) => (
        <li key={r.n} className="flex flex-wrap gap-x-2">
          <span className="text-zinc-400">{issueLink(r.issueRepo || r.repo || repo, r.issue, several)}</span>
          <span>{KIND_LABEL[r.kind]}</span>
          <span className="tabular-nums">{hrs(r.seconds)}</span>
          <span>{ENDING_LABEL[r.ending]}</span>
          <span className="tabular-nums">{dayLabel(new Date(r.endedAt * 1000).toISOString())}</span>
          {r.continued ? <span className="text-amber-400/80">taken up by a later run · half rate</span> : <span>not billed</span>}
        </li>
      ))}
    </ul>
  );
}

/** The runs going right now — their hours join the month when they end. */
export function LiveRuns({ runs, repo, several = false }: { runs: HoursLive[]; repo: string; several?: boolean }) {
  return (
    <span className="text-zinc-500">
      {' · running now: '}
      {runs.map((r, i) => (
        <span key={`${r.repo}:${r.kind}-${r.target}`}>
          {i > 0 && ', '}
          {issueLink(r.issueRepo || r.repo || repo, r.issue, several)} {KIND_LABEL[r.kind]} <span className="tabular-nums">{hrs(r.seconds)}</span>
        </span>
      ))}
    </span>
  );
}
