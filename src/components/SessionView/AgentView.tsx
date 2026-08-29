import useAgent from '../../hooks/use-agent';
import { elapsed, k, newInput } from '../../lib/format';
import Chat from '../Chat';

export default function AgentView({ id, agentId, onBack }: { id: string; agentId: string; onBack: () => void }) {
  const { data, error } = useAgent(id, agentId);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-zinc-800 px-4 py-2">
        <button onClick={onBack} className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800">
          ← back
        </button>
        <span className="text-sm font-medium text-zinc-100">{data?.description ?? agentId}</span>
        {data && (
          <span className="text-[11px] text-zinc-400">
            {data.subagentType ?? 'agent'} · {data.model ?? '—'} · {data.turns} turns · context {k(data.contextTokens)} ·
            new input {k(newInput(data.usage))} · cache reads {k(data.usage.cacheRead)} · out {k(data.usage.output)} ·{' '}
            {elapsed({ ...data, live: false })}
          </span>
        )}
      </div>
      {error && <p className="p-4 text-sm text-red-400">{String(error)}</p>}
      {!data && !error && <p className="p-4 text-sm text-zinc-400">Loading…</p>}
      {data && <Chat messages={data.messages} live={false} />}
    </div>
  );
}
