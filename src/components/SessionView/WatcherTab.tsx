import type { WatcherSession } from '../../../server/types';
import useFollowBottom from '../../hooks/use-follow-bottom';
import { Card, Row } from './Usage';

export default function WatcherTab({ watcher }: { watcher?: WatcherSession }) {
  const { ref } = useFollowBottom<HTMLPreElement>(true, watcher?.runLogTail);
  if (!watcher) return <p className="p-4 text-sm text-zinc-500">No watcher session dir is linked to this transcript.</p>;
  const st = watcher.state;
  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        <Card title="session dir">
          <Row label="name" value={watcher.name} />
          <Row label="pid" value={watcher.pid ?? '—'} />
          <Row label="alive" value={watcher.alive ? 'yes' : 'no'} />
          <Row label="retries" value={String(watcher.retries)} />
          <Row label="blocked" value={watcher.blocked ? 'yes' : 'no'} />
          <Row label="session id" value={watcher.sessionId ? watcher.sessionId.slice(0, 8) : '—'} />
        </Card>
        <Card title="state.json">
          <Row label="state" value={st?.state ?? '—'} />
          <Row label="step" value={st?.step ?? '—'} />
          <Row label="branch" value={st?.branch ?? '—'} />
          <Row label="pr" value={st?.pr?.replace(/.*\//, '#') ?? '—'} />
          <Row label="servers" value={st?.servers ?? '—'} />
          <Row label="since" value={st?.since ? new Date(st.since * 1000).toLocaleTimeString() : '—'} />
        </Card>
        <Card title={`inbox (${watcher.inbox.length})`}>
          {watcher.inbox.length ? (
            watcher.inbox.map((f) => <Row key={f} label="comment" value={f.replace(/\.md$/, '')} />)
          ) : (
            <Row label="—" value="empty" />
          )}
        </Card>
      </div>
      {st?.note && <p className="text-sm text-zinc-300">{st.note}</p>}
      <section>
        <h3 className="mb-1 text-[10px] font-semibold tracking-wide text-zinc-500 uppercase">run.log (tail)</h3>
        <pre
          ref={ref}
          className="max-h-96 overflow-auto rounded-md border border-zinc-800 bg-zinc-900/40 p-2 text-[11px] whitespace-pre-wrap text-zinc-400"
        >
          {watcher.runLogTail || '(empty)'}
        </pre>
      </section>
    </div>
  );
}
