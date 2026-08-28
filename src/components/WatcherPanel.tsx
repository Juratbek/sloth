import { useMemo } from 'react';
import type { Overview } from '../../server/types';
import useFollowBottom from '../hooks/use-follow-bottom';
import Board from './Board';
import IssuesTable from './IssuesTable';
import UsageChart from './UsageChart';

/** Queue as the log tells it: a "queued (slots full)" line stands until the same target is launched. */
function queued(logTail: string[]): string[] {
  const pending = new Set<string>();
  for (const line of logTail) {
    const target = /(?:(?:final )?review PR )?#(\d+)/.exec(line)?.[0];
    if (!target) continue;
    if (/queued \(slots full\)/.test(line)) pending.add(target);
    else if (/^\[[^\]]+\] (launch|review PR|final review PR) /.test(line)) pending.delete(target);
  }
  return [...pending];
}

export default function WatcherPanel({ overview, onSelect }: { overview: Overview; onSelect: (id: string) => void }) {
  const { watcher } = overview;
  const pending = useMemo(() => queued(watcher.logTail), [watcher.logTail]);
  const { ref: logRef } = useFollowBottom<HTMLPreElement>(true, watcher.logTail.length);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-4 overflow-hidden p-4">
      <Board board={overview.board} onSelect={onSelect} />

      <div className="shrink-0">
        <UsageChart />
      </div>

      <IssuesTable issues={overview.issues} config={overview.config} />

      {pending.length > 0 && (
        <section className="shrink-0 space-y-1">
          <h3 className="text-[10px] font-semibold tracking-wide text-zinc-500 uppercase">queued ({pending.length})</h3>
          <div className="flex flex-wrap gap-1">
            {pending.map((t) => (
              <span key={t} className="rounded border border-amber-900 bg-amber-950/40 px-1.5 py-0.5 text-[11px] text-amber-300">
                {t}
              </span>
            ))}
          </div>
        </section>
      )}

      <section className="flex min-h-0 flex-1 flex-col gap-1">
        <h3 className="text-[10px] font-semibold tracking-wide text-zinc-500 uppercase">watcher log</h3>
        <p className="text-[11px] text-zinc-600">
          seen comments {watcher.seen} · reviewed heads {watcher.reviewed}
        </p>
        <pre
          ref={logRef}
          className="min-h-0 flex-1 overflow-auto rounded-md border border-zinc-800 bg-zinc-900/40 p-2 text-[11px] whitespace-pre-wrap text-zinc-400"
        >
          {watcher.logTail.join('\n') || '(empty)'}
        </pre>
      </section>
    </div>
  );
}
