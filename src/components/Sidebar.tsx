import { useState } from 'react';
import type { SessionStatus, SessionSummary } from '../../server/types';
import { STATUS_COLOR, dayLabel, elapsed, k, label, modelName, stepLabel, usd } from '../lib/format';
import { inputStyle } from '../setup/ui';
import { LoadBrief } from './SessionLoad';
import Chip from './ui/Chip';

const GROUPS: { title: string; statuses: SessionStatus[]; byDay?: boolean }[] = [
  { title: 'Live', statuses: ['running', 'waiting'] },
  { title: 'Needs help', statuses: ['parked'] },
  { title: 'Finished', statuses: ['done'], byDay: true },
];

const endedAt = (s: SessionSummary) => s.lastAt ?? s.startedAt ?? '';

/** Case-insensitive match on what the row shows: its label ("issue #42"), title and issue number. */
export function matches(s: SessionSummary, query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [label(s), s.title ?? '', s.target ? `#${s.target}` : ''].some((t) => t.toLowerCase().includes(q));
}

/** Sessions bucketed by the local day they ended, newest day first — the server orders by start, which can differ. */
function groupByDay(rows: SessionSummary[]) {
  const out: { day: string; rows: SessionSummary[] }[] = [];
  for (const s of [...rows].sort((a, b) => endedAt(b).localeCompare(endedAt(a)))) {
    const at = endedAt(s);
    const day = at ? dayLabel(at) : 'Unknown';
    const last = out[out.length - 1];
    if (last?.day === day) last.rows.push(s);
    else out.push({ day, rows: [s] });
  }
  return out;
}

function Row({ s, active, onSelect }: { s: SessionSummary; active: boolean; onSelect: () => void }) {
  const step = s.watcher && stepLabel(s.watcher.kind, s.watcher.state?.step);
  const model = modelName(s.model);
  return (
    <button
      onClick={onSelect}
      className={`w-full border-b border-surface-raised px-3 py-2 text-left hover:bg-surface-raised ${active ? 'bg-surface-raised' : ''}`}
    >
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_COLOR[s.status]} ${s.status === 'running' ? 'animate-pulse' : ''}`} />
        <span className="text-sm font-medium text-fg-strong">{label(s)}</span>
        {step && (
          <Chip tone="solidDim" size="2xs">
            {step}
          </Chip>
        )}
        <span className="ml-auto text-[11px] text-fg-muted">{elapsed(s)}</span>
      </div>
      {s.title && <div className="mt-0.5 truncate pl-4 text-xs text-fg-muted">{s.title}</div>}
      <div className="mt-0.5 flex gap-2 pl-4 text-[11px] text-fg-muted">
        {model && (
          <span className="text-fg-soft" title={s.model}>
            {model}
          </span>
        )}
        <span>ctx {k(s.contextTokens)}</span>
        <span>↑{k(s.usage.output)}</span>
        {s.agents.length > 0 && <span>{s.agents.length} agents</span>}
        <LoadBrief load={s.watcher?.load} />
        {/* What this run cost, at the far end of the row — the same list-price estimate the board header
            and the session header show. A run with a model nobody has a price for shows nothing rather
            than a zero. */}
        {s.cost !== null && s.cost !== undefined && (
          <span className="ml-auto shrink-0 tabular-nums text-fg-faint" title="API list-price estimate for this run and its subagents">
            {usd(s.cost)}
          </span>
        )}
      </div>
    </button>
  );
}

export default function Sidebar({
  open,
  sessions,
  selected,
  onSelect,
}: {
  /** On a phone the list is the whole page when open and hidden otherwise; wider screens always show it. */
  open: boolean;
  sessions: SessionSummary[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const shown = sessions.filter((s) => matches(s, query));
  return (
    <aside className={`${open ? 'flex' : 'hidden'} w-full shrink-0 flex-col border-r border-edge md:flex md:w-80`}>
      <div className="border-b border-surface-raised p-2">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search sessions"
          aria-label="Search sessions"
          className={inputStyle}
          spellCheck={false}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {GROUPS.map((g) => {
          const rows = shown.filter((s) => g.statuses.includes(s.status));
          if (!rows.length) return null;
          return (
            <section key={g.title}>
              <h2 className="sticky top-0 bg-surface px-3 py-1.5 text-[11px] font-semibold tracking-wide text-fg-muted uppercase">
                {g.title} · {rows.length}
              </h2>
              {g.byDay
                ? groupByDay(rows).map((d) => (
                    <div key={d.day}>
                      <h3 className="border-b border-surface-raised bg-surface/80 px-3 py-1 text-[10px] font-medium text-fg-faint">
                        {d.day} · {d.rows.length}
                      </h3>
                      {d.rows.map((s) => (
                        <Row key={s.id} s={s} active={s.id === selected} onSelect={() => onSelect(s.id)} />
                      ))}
                    </div>
                  ))
                : rows.map((s) => <Row key={s.id} s={s} active={s.id === selected} onSelect={() => onSelect(s.id)} />)}
            </section>
          );
        })}
        {!sessions.length && <p className="p-4 text-sm text-fg-muted">No transcripts yet.</p>}
        {sessions.length > 0 && !shown.length && <p className="p-4 text-sm text-fg-muted">No sessions match “{query.trim()}”.</p>}
      </div>
    </aside>
  );
}
