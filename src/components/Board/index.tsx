import { useState } from 'react';
import type { ColumnRole } from '../../../server/config-types';
import type { BoardView } from '../../../server/types';
import { clock } from '../../lib/format';
import Column from './Column';

/** The needs-help column is called "Sloth needs help" on the board; the phone switcher has no room for that. */
const SHORT: Partial<Record<ColumnRole, string>> = { needsHelp: 'Help' };

/** A count of cards the view leaves out. Counted, never listed — this view is Sloth's pipeline. */
const Left = ({ label, count, title }: { label: string; count: number; title: string }) =>
  count ? (
    <span title={title} className="rounded border border-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-500">
      {label} · {count}
    </span>
  ) : null;

/**
 * Where every card Sloth is on is, and what it is doing there — the board as the last tick read it, in
 * Sloth's own pipeline order, given the whole window: half a screen shared with the chart and the log was
 * not enough to see a pipeline in. Only Sloth's cards are on it; the rest of the team's work is two counts
 * in the header. It mirrors GitHub and nothing more: no dragging, no buttons, no writes. Clicking a card
 * goes back to the monitor with the newest run on that issue open.
 */
export default function BoardPage({ board, onSelect, onClose }: { board?: BoardView; onSelect: (id: string) => void; onClose: () => void }) {
  const [tab, setTab] = useState<ColumnRole | null>(null);
  const columns = board?.columns ?? [];
  // On a phone one column shows at a time: the chosen one, else the first with work on it.
  const active = columns.find((c) => c.role === tab) ?? columns.find((c) => c.cards.length) ?? columns[0];

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-zinc-800 px-4 py-2">
        <span className="text-sm font-semibold text-zinc-100">Sloth</span>
        <span className="text-xs text-zinc-500">
          Board {board && <span className="ml-1 text-zinc-600">as of {clock(board.asOf)}</span>}
        </span>
        <span className="flex-1" />
        {board && <Left label="not Sloth's" count={board.others} title="Cards on Sloth's columns that Sloth has no run on and that are not waiting in pickup — a person's work." />}
        {board && <Left label="elsewhere" count={board.elsewhere} title="Cards on Status options Sloth has no column for." />}
        <button onClick={onClose} className="text-xs text-zinc-500 hover:text-zinc-200">
          ← Back
        </button>
      </header>

      {!board && <p className="flex flex-1 items-center justify-center p-6 text-sm text-zinc-500">The board has not been read yet — it fills in after the first tick.</p>}

      {board && (
        <>
          <div className="flex flex-wrap items-center gap-1 border-b border-zinc-800 px-3 py-2 md:hidden">
            {columns.map((c) => (
              <button
                key={c.role}
                onClick={() => setTab(c.role)}
                className={`rounded border px-1.5 py-0.5 text-[10px] ${
                  c.role === active?.role ? 'border-zinc-600 bg-zinc-900 text-zinc-200' : 'border-zinc-800 text-zinc-500'
                }`}
              >
                {SHORT[c.role] ?? c.name} {c.cards.length}
              </button>
            ))}
          </div>

          {active && (
            <div className="flex min-h-0 flex-1 flex-col p-3 md:hidden">
              <Column column={active} onSelect={onSelect} />
            </div>
          )}

          <div className="hidden min-h-0 flex-1 gap-3 overflow-x-auto p-4 md:flex">
            {columns.map((c) => (
              <Column key={c.role} column={c} onSelect={onSelect} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
