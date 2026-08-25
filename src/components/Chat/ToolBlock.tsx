import type { Block } from '../../../server/types';

type ToolUse = Extract<Block, { type: 'tool_use' }>;
type ToolResult = Extract<Block, { type: 'tool_result' }>;

const fields = (input: unknown): Record<string, unknown> =>
  input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined);

/** One-line gist of a tool call — the field that identifies what it did. */
export function summaryOf(name: string, input: unknown): string {
  const i = fields(input);
  switch (name) {
    case 'Bash':
      return str(i.description) ?? str(i.command) ?? '';
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return str(i.file_path) ?? '';
    case 'Agent':
    case 'Task':
      return [str(i.subagent_type), str(i.description)].filter(Boolean).join(' — ');
    case 'Skill':
      return [str(i.skill), str(i.args)].filter(Boolean).join(' ');
    case 'Grep':
    case 'Glob':
      return [str(i.pattern), str(i.path)].filter(Boolean).join('  in  ');
    case 'WebFetch':
    case 'WebSearch':
      return str(i.url) ?? str(i.query) ?? '';
    case 'ToolSearch':
      return str(i.query) ?? '';
    case 'TodoWrite':
      return `${Array.isArray(i.todos) ? i.todos.length : 0} todos`;
    default:
      return JSON.stringify(input ?? {}).slice(0, 160);
  }
}

function inputText(name: string, input: unknown): string {
  const i = fields(input);
  if (name === 'Bash' && str(i.command)) return String(i.command);
  return JSON.stringify(input ?? {}, null, 2);
}

export default function ToolBlock({
  block,
  result,
  onOpenAgent,
}: {
  block: ToolUse;
  result?: ToolResult;
  onOpenAgent?: (agentId: string) => void;
}) {
  const state = !result ? '·' : result.isError ? '✗' : '✓';
  const tone = !result ? 'text-zinc-600' : result.isError ? 'text-red-400' : 'text-emerald-400';
  const agentId = block.agentId;
  return (
    <details className="rounded-md border border-zinc-800 bg-zinc-900/40">
      <summary className="flex items-center gap-2 px-2 py-1 text-xs hover:bg-zinc-900">
        <span className={tone}>{state}</span>
        <span className="shrink-0 font-medium text-zinc-300">{block.name}</span>
        <span className="truncate font-mono text-[11px] text-zinc-500">{summaryOf(block.name, block.input)}</span>
        {agentId && onOpenAgent && (
          <button
            className="ml-auto shrink-0 rounded border border-zinc-700 px-1.5 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-800"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onOpenAgent(agentId);
            }}
          >
            Open subagent →
          </button>
        )}
      </summary>
      <div className="space-y-2 border-t border-zinc-800 p-2">
        <pre className="max-h-72 overflow-auto text-[11px] whitespace-pre-wrap text-zinc-400">
          {inputText(block.name, block.input)}
        </pre>
        {result && (
          <pre
            className={`max-h-72 overflow-auto border-t border-zinc-800 pt-2 text-[11px] whitespace-pre-wrap ${result.isError ? 'text-red-300' : 'text-zinc-500'}`}
          >
            {result.content}
            {result.truncated && '\n… truncated'}
          </pre>
        )}
      </div>
    </details>
  );
}
