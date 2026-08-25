import type { SessionStatus, SessionSummary } from '../../server/types';
import { STATUS_COLOR, elapsed, k, label } from '../lib/format';

const GROUPS: { title: string; statuses: SessionStatus[] }[] = [
  { title: 'Live', statuses: ['running', 'waiting'] },
  { title: 'Needs help', statuses: ['parked'] },
  { title: 'Finished', statuses: ['done'] },
];

function Row({ s, active, onSelect }: { s: SessionSummary; active: boolean; onSelect: () => void }) {
  const step = s.watcher?.state?.step;
  return (
    <button
      onClick={onSelect}
      className={`w-full border-b border-zinc-900 px-3 py-2 text-left hover:bg-zinc-900 ${active ? 'bg-zinc-900' : ''}`}
    >
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_COLOR[s.status]} ${s.status === 'running' ? 'animate-pulse' : ''}`} />
        <span className="text-sm font-medium text-zinc-100">{label(s)}</span>
        {step && <span className="rounded bg-zinc-800 px-1 text-[10px] text-zinc-400">step {step}</span>}
        <span className="ml-auto text-[11px] text-zinc-500">{elapsed(s)}</span>
      </div>
      {s.title && <div className="mt-0.5 truncate pl-4 text-xs text-zinc-400">{s.title}</div>}
      <div className="mt-0.5 flex gap-2 pl-4 text-[11px] text-zinc-500">
        <span>ctx {k(s.contextTokens)}</span>
        <span>↑{k(s.usage.output)}</span>
        {s.agents.length > 0 && <span>{s.agents.length} agents</span>}
      </div>
    </button>
  );
}

export default function Sidebar({
  sessions,
  selected,
  onSelect,
}: {
  sessions: SessionSummary[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <aside className="w-80 shrink-0 overflow-y-auto border-r border-zinc-800">
      {GROUPS.map((g) => {
        const rows = sessions.filter((s) => g.statuses.includes(s.status));
        if (!rows.length) return null;
        return (
          <section key={g.title}>
            <h2 className="sticky top-0 bg-zinc-950 px-3 py-1.5 text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">
              {g.title} · {rows.length}
            </h2>
            {rows.map((s) => (
              <Row key={s.id} s={s} active={s.id === selected} onSelect={() => onSelect(s.id)} />
            ))}
          </section>
        );
      })}
      {!sessions.length && <p className="p-4 text-sm text-zinc-500">No transcripts yet.</p>}
    </aside>
  );
}
