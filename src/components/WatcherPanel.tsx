import { useMemo } from 'react';
import type { BlockedCard, Overview } from '../../server/types';
import { duration } from '../lib/format';
import useFollowBottom from '../hooks/use-follow-bottom';
import useQaRun from '../hooks/use-qa-run';
import useUnblock from '../hooks/use-unblock';
import { queued } from '../lib/queued';
import IssuesTable from './IssuesTable';
import Chip from './ui/Chip';
import ErrorNote from './ui/ErrorNote';
import UsageChart from './UsageChart';

/** The QA sweep's line on the panel: its column, when it runs, and a button that runs it now. Nothing without a column. */
function QaSweep({ column, at }: { column: string; at: string }) {
  const run = useQaRun();
  return (
    <span>
      {' '}
      · QA sweep of {column} {at ? `daily at ${at}` : 'not scheduled'}{' '}
      <button onClick={() => run.mutate()} disabled={run.isPending} className="text-sky-400 hover:underline disabled:text-zinc-600" title="Test every card in the QA column now">
        {run.isPending ? 'sweeping…' : 'sweep now'}
      </button>{' '}
      <ErrorNote error={run.error} />
    </span>
  );
}

/**
 * The cards Sloth has given up on — the one state it will not leave on its own. Each row says why and
 * carries the button that hands the card back to the sweep; "sweep now" beside the log tests it at once.
 */
function Blocked({ cards, repo }: { cards: BlockedCard[]; repo: string }) {
  const unblock = useUnblock();
  return (
    <section className="shrink-0 space-y-1">
      <h3 className="text-[10px] font-semibold tracking-wide text-zinc-400 uppercase">blocked ({cards.length})</h3>
      <ul className="space-y-1">
        {cards.map((b) => (
          <li key={b.issue} className="flex items-baseline gap-2 rounded border border-red-900 bg-red-950/30 px-1.5 py-1 text-[11px]">
            <a
              href={`https://github.com/${repo}/issues/${b.issue}`}
              target="_blank"
              rel="noreferrer"
              className="shrink-0 tabular-nums text-red-300 hover:underline"
              title={b.title}
            >
              #{b.issue}
            </a>
            <span className="min-w-0 flex-1 truncate text-zinc-400" title={b.reason}>
              {b.reason}
            </span>
            <span className="shrink-0 tabular-nums text-zinc-500">{duration(Date.now() / 1000 - b.at)}</span>
            <button
              onClick={() => unblock.mutate(b.issue)}
              disabled={unblock.isPending}
              className="shrink-0 text-sky-400 hover:underline disabled:text-zinc-600"
              title="Forget the block and the heads already tested, so the next sweep tests this card again"
            >
              {unblock.isPending ? 'unblocking…' : 'unblock'}
            </button>
          </li>
        ))}
      </ul>
      <ErrorNote error={unblock.error} className="block" />
    </section>
  );
}

export default function WatcherPanel({ overview, onSelect }: { overview: Overview; onSelect: (id: string) => void }) {
  const { watcher, config } = overview;
  const pending = useMemo(() => queued(watcher.logTail), [watcher.logTail]);
  const { ref: logRef } = useFollowBottom<HTMLPreElement>(true, watcher.logTail.length);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-4 overflow-hidden p-4">
      <div className="shrink-0">
        <UsageChart />
      </div>

      {pending.length > 0 && (
        <section className="shrink-0 space-y-1">
          <h3 className="text-[10px] font-semibold tracking-wide text-zinc-400 uppercase">queued ({pending.length})</h3>
          <div className="flex flex-wrap gap-1">
            {pending.map((t) => (
              <Chip key={t} tone="amber" size="sm">
                {t}
              </Chip>
            ))}
          </div>
        </section>
      )}

      {overview.blocked.length > 0 && <Blocked cards={overview.blocked} repo={config.repo} />}

      <div className="flex min-h-0 flex-1 flex-col gap-4 md:flex-row">
        <IssuesTable issues={overview.issues} config={overview.config} />

        <section className="flex min-h-0 min-w-0 flex-1 basis-0 flex-col gap-1">
          <h3 className="text-[10px] font-semibold tracking-wide text-zinc-400 uppercase">watcher log</h3>
          <p className="text-[11px] text-zinc-500">
            seen comments {watcher.seen} · reviewed heads {watcher.reviewed}
            {config.qaColumn && <QaSweep column={config.qaColumn} at={config.qaAt} />}
          </p>
          <pre
            ref={logRef}
            className="min-h-0 flex-1 overflow-auto rounded-md border border-zinc-800 bg-zinc-900/40 p-2 text-[11px] whitespace-pre-wrap text-zinc-400"
          >
            {watcher.logTail.join('\n') || '(empty)'}
          </pre>
        </section>
      </div>
    </div>
  );
}
