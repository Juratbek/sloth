import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { promptOf, readRecords, summarize, toMessages } from '../server/transcripts';
import { root } from './harness';

const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 };
const records = [
  { type: 'queue-operation', content: '/sloth:implement 42 ' },
  { type: 'user', uuid: 'u1', timestamp: '2026-08-28T10:00:00Z', message: { content: 'hello' } },
  { type: 'assistant', uuid: 'a1', requestId: 'r1', timestamp: '2026-08-28T10:00:01Z', message: { model: 'claude-opus-5', usage, content: [{ type: 'text', text: 'thinking about it' }] } },
  { type: 'assistant', uuid: 'a2', requestId: 'r1', timestamp: '2026-08-28T10:00:02Z', message: { model: 'claude-opus-5', usage, content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } },
  { type: 'user', uuid: 'u2', timestamp: '2026-08-28T10:00:03Z', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a\nb' }] } },
  { type: 'assistant', uuid: 'a3', requestId: 'r2', timestamp: '2026-08-28T10:00:04Z', message: { model: 'claude-opus-5', usage, content: [{ type: 'text', text: 'done: PR opened' }] } },
];

function transcript(): string {
  const file = path.join(root(), 'session.jsonl');
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

describe('transcripts', () => {
  it('reads records incrementally and ignores a partial last line', () => {
    const file = transcript();
    expect(readRecords(file)).toHaveLength(6);
    fs.appendFileSync(file, '{"type":"user","uuid":"u3"');
    expect(readRecords(file)).toHaveLength(6);
    fs.appendFileSync(file, '}\n');
    expect(readRecords(file)).toHaveLength(7);
  });
  it('summarizes one row per API request, keeping the last text', () => {
    const s = summarize(readRecords(transcript()));
    expect(s.turns).toBe(2);
    expect(s.usage.input).toBe(20);
    expect(s.contextTokens).toBe(130);
    expect(s.toolCounts).toEqual({ Bash: 1 });
    expect(s.lastText).toBe('done: PR opened');
    expect(s.byModel[0]).toMatchObject({ model: 'claude-opus-5', requests: 2 });
  });
  it('merges the records of one request into one assistant message', () => {
    const m = toMessages(readRecords(transcript()));
    expect(m.map((x) => x.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(m[1].blocks.map((b) => b.type)).toEqual(['text', 'tool_use']);
    expect(m[2].blocks[0]).toMatchObject({ type: 'tool_result', toolUseId: 't1', content: 'a\nb' });
  });
  it('takes the prompt from the queue operation, else the command tags', () => {
    expect(promptOf(readRecords(transcript()))).toBe('/sloth:implement 42');
    const tagged = [{ type: 'user', message: { content: '<command-name>/sloth:review</command-name><command-args>12 final</command-args>' } }];
    expect(promptOf(tagged)).toBe('/sloth:review 12 final');
  });
});
