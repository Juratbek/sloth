import type { ToolCounts } from '../../../server/types';
import { k } from '../../lib/format';
import Chip from '../ui/Chip';

export function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-zinc-800 px-3 py-2">
      <h3 className="mb-1 text-[10px] font-semibold tracking-wide text-zinc-400 uppercase">{title}</h3>
      <dl className="space-y-0.5 text-xs">{children}</dl>
    </div>
  );
}

export function Row({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-zinc-400">{label}</dt>
      <dd className="font-mono text-zinc-200">{value}</dd>
    </div>
  );
}

export function ToolChips({ counts }: { counts: ToolCounts }) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return null;
  return (
    <div className="flex flex-wrap gap-1 overflow-hidden text-[11px] whitespace-nowrap">
      {entries.map(([name, n]) => (
        <Chip key={name} size="sm">
          {name} <span className="text-zinc-200">{n}</span>
        </Chip>
      ))}
    </div>
  );
}
