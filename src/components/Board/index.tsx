import { useState } from 'react';
import type { ColumnRole } from '../../../server/config-types';
import type { BoardView } from '../../../server/types';
import useCollapsed from '../../hooks/use-collapsed';
import { clock } from '../../lib/format';
import Column from './Column';

/** The needs-help column is called "Sloth needs help" on the board; the phone switcher has no room for that. */
const SHORT: Partial<Record<ColumnRole, string>> = { needsHelp: 'Help' };

/** Cards on Status options Sloth has no role for. Counted, never listed — this view is Sloth's pipeline. */
const Elsewhere = ({ count }: { count: number }) =>
  count ? (
    <span className="shrink-0 self-start rounded border border-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-500">elsewhere · {count}</span>
  ) : null;

/**
 * Where every card is, and whether Sloth is on it — the board as the last tick read it, in Sloth's own
 * pipeline order. It mirrors GitHub and nothing more: no dragging, no buttons, no writes. Clicking a
 * card opens the newest run on that issue.
 */
export default function Board({ board, onSelect }: { board?: BoardView; onSelect: (id: string) => void }) {
  const [collapsed, setCollapsed] = useCollapsed('sloth.board.collapsed');
  const [tab, setTab] = useState<ColumnRole | null>(null);
  const columns = board?.columns ?? [];
  // On a phone one column shows at a time: the chosen one, else the first with work on it.
  const active = columns.find((c) => c.role === tab) ?? columns.find((c) => c.cards.length) ?? columns[0];

  return (
    <section className="shrink-0 space-y-1">
      <div className="flex items-baseline gap-x-2">
        <h3 className="text-[10px] font-semibold tracking-wide text-zinc-500 uppercase">board</h3>
        <span className="text-[11px] text-zinc-500">{board ? `as of ${clock(board.asOf)}` : 'board not read yet'}</span>
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="ml-auto rounded border border-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300"
        >
          {collapsed ? 'show' : 'hide'}
        </button>
      </div>

      {!collapsed && board && (
        <>
          <div className="flex flex-wrap items-center gap-1 md:hidden">
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
            <Elsewhere count={board.elsewhere} />
          </div>

          {active && (
            <div className="max-h-72 overflow-y-auto md:hidden">
              <Column column={active} onSelect={onSelect} />
            </div>
          )}

          <div className="hidden max-h-72 gap-3 overflow-auto md:flex">
            {columns.map((c) => (
              <Column key={c.role} column={c} onSelect={onSelect} />
            ))}
            <Elsewhere count={board.elsewhere} />
          </div>
        </>
      )}
    </section>
  );
}
