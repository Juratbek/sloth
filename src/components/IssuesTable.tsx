import type { IssueCost, MonitorConfig } from '../../server/types';
import { STATUS_COLOR, ago, k, usd } from '../lib/format';

/**
 * What every issue Sloth touched has cost. The sessions list is per run — an issue that took four
 * relaunches and two reviews spreads over six rows there — so this is the only place the answer to
 * "what did #42 cost me" is one line. Dearest first, as the server rolled it up.
 */
export default function IssuesTable({ issues, config }: { issues: IssueCost[]; config: MonitorConfig }) {
  if (!issues.length) return null;
  return (
    <section className="shrink-0 space-y-1">
      <h3 className="text-[10px] font-semibold tracking-wide text-zinc-500 uppercase">cost by issue ({issues.length})</h3>
      <div className="max-h-48 overflow-auto rounded-md border border-zinc-800">
        <table className="w-full text-[11px]">
          <thead className="sticky top-0 bg-zinc-900 text-zinc-500">
            <tr>
              <th className="px-2 py-1 text-left font-medium">issue</th>
              <th className="hidden px-2 py-1 text-left font-medium sm:table-cell">title</th>
              <th className="px-2 py-1 text-right font-medium">runs</th>
              <th className="hidden px-2 py-1 text-right font-medium sm:table-cell">tokens</th>
              <th className="px-2 py-1 text-right font-medium">last</th>
              <th className="px-2 py-1 text-right font-medium">cost</th>
            </tr>
          </thead>
          <tbody className="text-zinc-400">
            {issues.map((i) => (
              <tr key={i.issue} className="border-t border-zinc-800/70">
                <td className="px-2 py-1 whitespace-nowrap">
                  <span className="flex items-center gap-1.5">
                    {i.status && <span className={`h-1.5 w-1.5 rounded-full ${STATUS_COLOR[i.status]}`} />}
                    {config.repo ? (
                      <a
                        href={`https://github.com/${config.repo}/issues/${i.issue}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-zinc-300 hover:underline"
                      >
                        #{i.issue}
                      </a>
                    ) : (
                      <span>#{i.issue}</span>
                    )}
                  </span>
                </td>
                <td className="hidden max-w-0 truncate px-2 py-1 sm:table-cell">{i.title ?? ''}</td>
                <td className="px-2 py-1 text-right tabular-nums">{i.sessions}</td>
                <td className="hidden px-2 py-1 text-right tabular-nums sm:table-cell">
                  {k(i.tokens.input + i.tokens.output)}
                </td>
                <td className="px-2 py-1 text-right whitespace-nowrap tabular-nums">{i.lastAt ? `${ago(i.lastAt)} ago` : '—'}</td>
                <td className="px-2 py-1 text-right tabular-nums text-zinc-300">{i.cost === null ? '—' : usd(i.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
