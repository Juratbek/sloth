import { useMemo } from 'react';
import type { Block, Message } from '../../../server/types';
import useFollowBottom from '../../hooks/use-follow-bottom';
import MessageItem from './MessageItem';

type ToolResult = Extract<Block, { type: 'tool_result' }>;

/** Tool results are rendered inside their tool call, so a user message that carries only results is skipped. */
function split(messages: Message[]) {
  const results = new Map<string, ToolResult>();
  const visible: Message[] = [];
  for (const m of messages) {
    let text = m.role === 'assistant';
    for (const b of m.blocks) {
      if (b.type === 'tool_result') results.set(b.toolUseId, b);
      else text = true;
    }
    if (text) visible.push(m);
  }
  return { results, visible };
}

export default function Chat({
  messages,
  live,
  onOpenAgent,
}: {
  messages: Message[];
  live: boolean;
  onOpenAgent?: (agentId: string) => void;
}) {
  const { results, visible } = useMemo(() => split(messages), [messages]);
  const { ref, follow, setFollow } = useFollowBottom<HTMLDivElement>(live, messages.length);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-zinc-900 px-4 py-1 text-[11px] text-zinc-400">
        <span>{visible.length} messages</span>
        <label className="ml-auto flex cursor-pointer items-center gap-1.5">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          Follow
        </label>
      </div>
      <div ref={ref} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3">
        {visible.map((m) => (
          <MessageItem key={m.uuid} message={m} results={results} onOpenAgent={onOpenAgent} />
        ))}
        {!visible.length && <p className="text-sm text-zinc-400">No messages yet.</p>}
      </div>
    </div>
  );
}
