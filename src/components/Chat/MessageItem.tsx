import type { Block, Message } from '../../../server/types';
import { clock, contextOf, k } from '../../lib/format';
import ToolBlock from './ToolBlock';

type ToolResult = Extract<Block, { type: 'tool_result' }>;

/** A slash-command prompt arrives as XML wrapper tags — show the command line instead. */
function readable(raw: string) {
  const name = /<command-name>(.*?)<\/command-name>/.exec(raw)?.[1];
  if (!name) return raw;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(raw)?.[1] ?? '';
  return `${name} ${args}`.trim();
}

function UserMessage({ message }: { message: Message }) {
  const text = readable(
    message.blocks
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('\n')
      .trim(),
  );
  return (
    <div className="flex justify-end">
      <div className="max-h-96 max-w-3xl overflow-auto rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm whitespace-pre-wrap text-zinc-300">
        {text}
      </div>
    </div>
  );
}

function Footer({ message }: { message: Message }) {
  const u = message.usage;
  return (
    <div className="flex gap-3 pt-1 text-[11px] text-zinc-600">
      <span>{clock(message.timestamp)}</span>
      {message.model && <span>{message.model}</span>}
      {u && (
        <span>
          ctx {k(contextOf(u))} · ↑{k(u.output)}
          {u.thinking > 0 && ` · ${k(u.thinking)} thinking`}
        </span>
      )}
    </div>
  );
}

export default function MessageItem({
  message,
  results,
  onOpenAgent,
}: {
  message: Message;
  results: Map<string, ToolResult>;
  onOpenAgent?: (agentId: string) => void;
}) {
  if (message.role === 'user') return <UserMessage message={message} />;
  return (
    <div className="space-y-1.5">
      {message.blocks.map((b, i) => {
        if (b.type === 'text')
          return (
            <p key={i} className="max-w-4xl text-sm break-words whitespace-pre-wrap text-zinc-200">
              {b.text}
            </p>
          );
        if (b.type === 'thinking')
          return (
            <details key={i} className="max-w-4xl">
              <summary className="text-xs text-zinc-600 hover:text-zinc-400">thinking…</summary>
              <p className="mt-1 border-l border-zinc-800 pl-3 text-xs whitespace-pre-wrap text-zinc-500 italic">
                {b.text}
              </p>
            </details>
          );
        if (b.type === 'tool_use')
          return <ToolBlock key={b.id} block={b} result={results.get(b.id)} onOpenAgent={onOpenAgent} />;
        return null;
      })}
      <Footer message={message} />
    </div>
  );
}
