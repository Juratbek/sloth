import type { ModelUsage, Stats, ToolCounts, Usage } from './types';
import { forgetHot, readNew, type Rec } from './jsonl';

export const zero = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 });
export function add(a: Usage, b: Usage) {
  a.input += b.input;
  a.output += b.output;
  a.cacheRead += b.cacheRead;
  a.cacheWrite += b.cacheWrite;
  a.thinking += b.thinking;
}
export function usageOf(u: Rec): Usage {
  return {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    thinking: u.output_tokens_details?.thinking_tokens ?? 0,
  };
}

/**
 * What the sessions list needs of a transcript, folded in as the file grows so the records themselves are
 * never kept: the stats, the prompt, and the Agent calls that link the parent to its subagent files.
 */
export interface Digest {
  usage: Usage;
  models: Map<string, ModelUsage>;
  seen: Set<string>;
  toolCounts: ToolCounts;
  startedAt?: string;
  lastAt?: string;
  lastText: string;
  contextTokens: number;
  turns: number;
  /** The `queue-operation` text and the first user message, for `promptOf`. */
  queued?: string;
  firstUser?: string;
  /** Agent / Task tool calls in order, and the subagent each tool result named. */
  calls: { id: string; prompt: string; description?: string; subagentType?: string; model?: string }[];
  resultAgent: Map<string, string>;
}

export const newDigest = (): Digest => ({ usage: zero(), models: new Map(), seen: new Set(), toolCounts: {}, lastText: '', contextTokens: 0, turns: 0, calls: [], resultAgent: new Map() });

export function feed(d: Digest, records: Rec[]): void {
  for (const r of records) {
    if (r.timestamp) {
      d.startedAt ??= r.timestamp;
      d.lastAt = r.timestamp;
    }
    if (d.queued === undefined && r.type === 'queue-operation' && typeof r.content === 'string') d.queued = r.content;
    if (r.type === 'user' && r.message) {
      if (d.firstUser === undefined && typeof r.message.content === 'string') d.firstUser = r.message.content;
      const id = r.toolUseResult?.agentId;
      const toolUseId = Array.isArray(r.message.content) ? r.message.content[0]?.tool_use_id : undefined;
      if (id && toolUseId) d.resultAgent.set(toolUseId, id);
    }
    if (r.type !== 'assistant' || !r.message) continue;
    for (const b of r.message.content ?? []) {
      if (b.type === 'tool_use') {
        d.toolCounts[b.name] = (d.toolCounts[b.name] ?? 0) + 1;
        if (b.name === 'Agent' || b.name === 'Task')
          d.calls.push({ id: b.id, prompt: (b.input?.prompt ?? '').slice(0, 4000), description: b.input?.description, subagentType: b.input?.subagent_type, model: b.input?.model });
      }
      if (b.type === 'text' && b.text?.trim()) d.lastText = b.text.slice(-600);
    }
    const key: string = r.requestId ?? r.uuid;
    if (d.seen.has(key) || !r.message.usage) continue;
    d.seen.add(key);
    d.turns++;
    const u = usageOf(r.message.usage);
    add(d.usage, u);
    d.contextTokens = u.input + u.cacheRead + u.cacheWrite;
    const model: string = r.message.model ?? 'unknown';
    const mu = d.models.get(model) ?? { model, requests: 0, ...zero() };
    mu.requests++;
    add(mu, u);
    d.models.set(model, mu);
  }
}

export function statsOf(d: Digest): Stats {
  const byModel = [...d.models.values()].map((m) => ({ ...m }));
  return { usage: { ...d.usage }, byModel, model: mainModel(byModel), toolCounts: { ...d.toolCounts }, startedAt: d.startedAt, lastAt: d.lastAt, turns: d.turns, contextTokens: d.contextTokens, lastText: d.lastText };
}

const digests = new Map<string, { offset: number; digest: Digest }>();

/** The digest of a transcript, brought up to date with whatever was appended since the last call. */
export function digestFile(file: string): Digest {
  let c = digests.get(file);
  if (!c) digests.set(file, (c = { offset: 0, digest: newDigest() }));
  const { records, offset } = readNew(file, c.offset);
  if (offset < c.offset) c.digest = newDigest();
  feed(c.digest, records);
  c.offset = offset;
  return c.digest;
}

/** Forgets a transcript that is gone — the sweep deleted it, or it was never one. */
export function forgetTranscript(file: string): void {
  digests.delete(file);
  forgetHot(file);
}

/**
 * The model a run ran on: the one that answered most of its requests. `<synthetic>` rows (the CLI's own
 * messages, no tokens) and unknown ones are not it — a run's last usage-limit message must not rename it.
 */
export function mainModel(byModel: ModelUsage[]): string | undefined {
  return byModel
    .filter((m) => m.model !== 'unknown' && !m.model.startsWith('<') && m.input + m.output + m.cacheRead + m.cacheWrite > 0)
    .sort((a, b) => b.requests - a.requests)[0]?.model;
}

/** The queued command, else the slash command and its arguments out of the first user message, else its first 200 characters. */
export function promptFrom(d: Digest): string {
  if (d.queued !== undefined) return d.queued.trim();
  const c = d.firstUser ?? '';
  const name = /<command-name>(.*?)<\/command-name>/.exec(c)?.[1];
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(c)?.[1];
  return name ? `${name} ${args ?? ''}`.trim() : c.slice(0, 200);
}
