import type { AgentSummary } from '../../server/types';
import { elapsed, k, newInput } from '../lib/format';

const tools = (counts: Record<string, number>) =>
  Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `${name} ${n}`)
    .join(' · ');

export default function Agents({ agents, onOpen }: { agents: AgentSummary[]; onOpen: (agentId: string) => void }) {
  if (!agents.length) return <p className="p-4 text-sm text-zinc-400">This session started no subagents.</p>;
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table className="w-full text-left text-xs">
        <thead className="sticky top-0 bg-zinc-950 text-[11px] text-zinc-400 uppercase">
          <tr>
            {['Description', 'Type', 'Model', 'Turns', 'Context', 'New input', 'Cache reads', 'Out', 'Duration', 'Tools', 'Last text'].map(
              (h) => (
                <th key={h} className="border-b border-zinc-800 px-3 py-1.5 font-medium">
                  {h}
                </th>
              ),
            )}
          </tr>
        </thead>
        <tbody>
          {agents.map((a) => (
            <tr
              key={a.agentId}
              onClick={() => onOpen(a.agentId)}
              className="cursor-pointer border-b border-zinc-900 align-top hover:bg-zinc-900"
            >
              <td className="max-w-56 px-3 py-2 text-zinc-200">{a.description ?? a.agentId}</td>
              <td className="px-3 py-2 text-zinc-400">{a.subagentType ?? '—'}</td>
              <td className="px-3 py-2 text-zinc-400">{a.model ?? '—'}</td>
              <td className="px-3 py-2 text-zinc-400">{a.turns}</td>
              <td className="px-3 py-2 text-zinc-400">{k(a.contextTokens)}</td>
              <td className="px-3 py-2 text-zinc-400">{k(newInput(a.usage))}</td>
              <td className="px-3 py-2 text-zinc-400">{k(a.usage.cacheRead)}</td>
              <td className="px-3 py-2 text-zinc-400">{k(a.usage.output)}</td>
              <td className="px-3 py-2 text-zinc-400">{elapsed({ ...a, live: false })}</td>
              <td className="max-w-56 truncate px-3 py-2 text-zinc-400">{tools(a.toolCounts)}</td>
              <td className="max-w-96 px-3 py-2 text-zinc-400">
                <span className="line-clamp-2">{a.lastText}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
