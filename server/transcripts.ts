import fs from 'node:fs';
import type { Block, Message, ModelUsage, Stats, ToolCounts, Usage } from './types';

/** Transcript records are free-form JSON; each reader picks out the fields it knows. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Rec = any;
const MAX_RESULT = 20_000;

const cache = new Map<string, { bytes: number; records: Rec[] }>();

/** Incrementally parses a .jsonl transcript; only bytes appended since the last call are read. */
export function readRecords(file: string): Rec[] {
  const size = fs.statSync(file).size;
  let c = cache.get(file);
  if (!c || size < c.bytes) {
    c = { bytes: 0, records: [] };
    cache.set(file, c);
  }
  if (size === c.bytes) return c.records;
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - c.bytes);
    fs.readSync(fd, buf, 0, buf.length, c.bytes);
    const text = buf.toString('utf8');
    const end = text.lastIndexOf('\n');
    if (end < 0) return c.records;
    for (const line of text.slice(0, end).split('\n')) {
      if (!line.trim()) continue;
      try {
        c.records.push(JSON.parse(line));
      } catch {
        /* corrupt line */
      }
    }
    c.bytes += Buffer.byteLength(text.slice(0, end + 1), 'utf8');
  } finally {
    fs.closeSync(fd);
  }
  return c.records;
}

export const zero = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 });
export function add(a: Usage, b: Usage) {
  a.input += b.input;
  a.output += b.output;
  a.cacheRead += b.cacheRead;
  a.cacheWrite += b.cacheWrite;
  a.thinking += b.thinking;
}
function usageOf(u: Rec): Usage {
  return {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    thinking: u.output_tokens_details?.thinking_tokens ?? 0,
  };
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);
  return content
    .map((c) => (c?.type === 'text' ? c.text : c?.type === 'image' ? '[image]' : JSON.stringify(c)))
    .join('\n');
}

function clip(text: string): { content: string; truncated: boolean } {
  return text.length > MAX_RESULT
    ? { content: text.slice(0, MAX_RESULT), truncated: true }
    : { content: text, truncated: false };
}

function userBlocks(content: unknown): Block[] {
  if (typeof content === 'string') return content.trim() ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  return content.flatMap((c): Block[] => {
    if (c.type === 'tool_result')
      return [{ type: 'tool_result', toolUseId: c.tool_use_id, isError: !!c.is_error, ...clip(textOf(c.content)) }];
    if (c.type === 'text' && c.text?.trim()) return [{ type: 'text', text: c.text }];
    return [];
  });
}

function assistantBlock(b: Rec): Block | undefined {
  if (b.type === 'text') return { type: 'text', text: b.text ?? '' };
  if (b.type === 'thinking') return { type: 'thinking', text: b.thinking ?? '' };
  if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
  return undefined;
}

/** Records of the same API response (same requestId) are merged into one assistant message. */
export function toMessages(records: Rec[]): Message[] {
  const msgs: Message[] = [];
  const byRequest = new Map<string, Message>();
  for (const r of records) {
    if ((r.type !== 'user' && r.type !== 'assistant') || !r.message || r.isMeta) continue;
    if (r.type === 'user') {
      const blocks = userBlocks(r.message.content);
      if (blocks.length) msgs.push({ uuid: r.uuid, role: 'user', timestamp: r.timestamp, blocks });
      continue;
    }
    const key: string = r.requestId ?? r.uuid;
    let msg = byRequest.get(key);
    if (!msg) {
      msg = {
        uuid: r.uuid,
        role: 'assistant',
        timestamp: r.timestamp,
        blocks: [],
        model: r.message.model,
        usage: r.message.usage ? usageOf(r.message.usage) : undefined,
      };
      byRequest.set(key, msg);
      msgs.push(msg);
    }
    for (const b of r.message.content ?? []) {
      const block = assistantBlock(b);
      if (block) msg.blocks.push(block);
    }
  }
  return msgs;
}

export function summarize(records: Rec[]): Stats {
  const usage = zero();
  const models = new Map<string, ModelUsage>();
  const seen = new Set<string>();
  const toolCounts: ToolCounts = {};
  let startedAt: string | undefined, lastAt: string | undefined, lastText = '';
  let contextTokens = 0, turns = 0;
  for (const r of records) {
    if (r.timestamp) {
      startedAt ??= r.timestamp;
      lastAt = r.timestamp;
    }
    if (r.type !== 'assistant' || !r.message) continue;
    for (const b of r.message.content ?? []) {
      if (b.type === 'tool_use') toolCounts[b.name] = (toolCounts[b.name] ?? 0) + 1;
      if (b.type === 'text' && b.text?.trim()) lastText = b.text;
    }
    const key: string = r.requestId ?? r.uuid;
    if (seen.has(key) || !r.message.usage) continue;
    seen.add(key);
    turns++;
    const u = usageOf(r.message.usage);
    add(usage, u);
    contextTokens = u.input + u.cacheRead + u.cacheWrite;
    const model: string = r.message.model ?? 'unknown';
    const mu = models.get(model) ?? { model, requests: 0, ...zero() };
    mu.requests++;
    add(mu, u);
    models.set(model, mu);
  }
  return { usage, byModel: [...models.values()], toolCounts, startedAt, lastAt, turns, contextTokens, lastText: lastText.slice(-600) };
}

export function promptOf(records: Rec[]): string {
  const q = records.find((r) => r.type === 'queue-operation' && typeof r.content === 'string');
  if (q) return q.content.trim();
  const u = records.find((r) => r.type === 'user' && typeof r.message?.content === 'string');
  const c: string = u?.message?.content ?? '';
  const name = /<command-name>(.*?)<\/command-name>/.exec(c)?.[1];
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(c)?.[1];
  return name ? `${name} ${args ?? ''}`.trim() : c.slice(0, 200);
}
