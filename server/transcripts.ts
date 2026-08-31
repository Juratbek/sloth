import type { Block, Message, Stats } from './types';
import { feed, newDigest, promptFrom, statsOf, usageOf } from './digest';
import type { Rec } from './jsonl';

export { HOT, hotFiles, readNew, readRecords, type Rec } from './jsonl';
export { add, digestFile, feed, forgetTranscript, mainModel, newDigest, promptFrom, statsOf, zero, type Digest } from './digest';

const MAX_RESULT = 20_000;

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
  const d = newDigest();
  feed(d, records);
  return statsOf(d);
}

export function promptOf(records: Rec[]): string {
  const d = newDigest();
  feed(d, records);
  return promptFrom(d);
}

