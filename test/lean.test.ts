import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cfg } from '../server/config';
import { HOT, digestFile, hotFiles, promptFrom, readRecords, statsOf } from '../server/transcripts';
import { listAgents, applyLinks } from '../server/agents';
import { overview, sessionDetail } from '../server/sessions';
import { usageSeries } from '../server/usage';
import { tailOf } from '../server/watcher';
import { resetGh } from './gh-mock';
import { configure, root, wipe } from './harness';

vi.mock('../server/runner/gh', () => import('./gh-mock'));

const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 };
const at = (s: number) => new Date(Date.now() - 60_000 + s * 1000).toISOString();
const records = (n: number) => [
  { type: 'queue-operation', content: `/sloth:implement ${n} ` },
  { type: 'user', uuid: 'u1', timestamp: at(0), message: { content: 'hello' } },
  { type: 'assistant', uuid: 'a1', requestId: 'r1', timestamp: at(1), message: { model: 'claude-opus-5', usage, content: [{ type: 'text', text: 'thinking' }] } },
  { type: 'assistant', uuid: 'a2', requestId: 'r1', timestamp: at(2), message: { model: 'claude-opus-5', usage, content: [{ type: 'tool_use', id: 't1', name: 'Agent', input: { prompt: 'test it', description: 'tester', subagent_type: 'tester', model: 'sonnet' } }] } },
  { type: 'user', uuid: 'u2', timestamp: at(3), toolUseResult: { agentId: 'abc' }, message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
  { type: 'assistant', uuid: 'a3', requestId: 'r2', timestamp: at(4), message: { model: 'claude-opus-5', usage, content: [{ type: 'text', text: 'done: PR opened' }] } },
];
const lines = (rs: object[]) => rs.map((r) => JSON.stringify(r)).join('\n') + '\n';
const transcript = (id: string, n = 42) => {
  const dir = cfg().transcriptsDir;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, lines(records(n)));
  return file;
};

beforeEach(() => {
  configure();
  wipe();
  resetGh();
  fs.rmSync(cfg().transcriptsDir, { recursive: true, force: true });
});

describe('a digest instead of the records', () => {
  it('folds a transcript as it grows, keeping the stats, the prompt and the agent links without the records', () => {
    const file = transcript('s1');
    const d = digestFile(file);
    expect(statsOf(d)).toMatchObject({ turns: 2, model: 'claude-opus-5', lastText: 'done: PR opened', toolCounts: { Agent: 1 } });
    expect(promptFrom(d)).toBe('/sloth:implement 42');
    expect(d.calls).toEqual([{ id: 't1', prompt: 'test it', description: 'tester', subagentType: 'tester', model: 'sonnet' }]);
    expect(d.resultAgent.get('t1')).toBe('abc');
    fs.appendFileSync(file, lines([{ type: 'assistant', uuid: 'a4', requestId: 'r3', timestamp: at(5), message: { model: 'claude-opus-5', usage, content: [{ type: 'text', text: 'and merged' }] } }]));
    expect(statsOf(digestFile(file))).toMatchObject({ turns: 3, lastText: 'and merged' });
    expect(promptFrom(digestFile(file))).toBe('/sloth:implement 42');
    fs.writeFileSync(file, lines(records(7).slice(0, 2))); // replaced by a shorter file: starts over
    expect(statsOf(digestFile(file)).turns).toBe(0);
    expect(promptFrom(digestFile(file))).toBe('/sloth:implement 7');
    expect(hotFiles()).not.toContain(file);
  });

  it('keeps the records of the HOT most recently read transcripts only', () => {
    const files = Array.from({ length: HOT + 2 }, (_, i) => transcript(`h${i}`));
    for (const f of files) expect(readRecords(f)).toHaveLength(6);
    expect(hotFiles()).toEqual(files.slice(2));
    readRecords(files[0]); // asked for again: back in, the oldest out
    expect(hotFiles()).toEqual([...files.slice(3), files[0]]);
  });

  it('lists sessions and their subagents from digests, and the detail view from the records', async () => {
    const file = transcript('s2');
    const agents = path.join(cfg().transcriptsDir, 's2', 'subagents');
    fs.mkdirSync(agents, { recursive: true });
    fs.writeFileSync(path.join(agents, 'agent-abc.jsonl'), lines([{ type: 'user', uuid: 'x', timestamp: at(2), message: { content: 'test it' } }, { type: 'assistant', uuid: 'y', requestId: 'q1', timestamp: at(3), message: { model: 'claude-sonnet-5', usage, content: [{ type: 'text', text: 'all good' }] } }]));
    const list = listAgents(file);
    expect(list).toHaveLength(1);
    applyLinks(digestFile(file), list);
    expect(list[0]).toMatchObject({ agentId: 'abc', prompt: 'test it', description: 'tester', subagentType: 'tester', model: 'sonnet', toolUseId: 't1' });
    const o = await overview();
    expect(o.sessions.map((s) => s.id)).toEqual(['s2']);
    expect(o.sessions[0]).toMatchObject({ prompt: '/sloth:implement 42', kind: 'sloth:implement', target: 42, turns: 2 });
    expect(o.sessions[0].agents[0]).toMatchObject({ agentId: 'abc', model: 'sonnet' });
    expect(hotFiles()).not.toContain(file); // the list never loaded the records
    const detail = sessionDetail('s2')!;
    expect(detail.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(hotFiles()).toContain(file);
  });

  it('sums the usage page from per-file folds that follow appends', () => {
    const file = transcript('u1');
    fs.mkdirSync(path.join(cfg().transcriptsDir, 'u1', 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(cfg().transcriptsDir, 'u1', 'subagents', 'agent-z.jsonl'), lines([{ type: 'assistant', uuid: 'z1', requestId: 'z1', timestamp: at(3), message: { model: 'claude-opus-5', usage, content: [] } }]));
    const before = usageSeries(1);
    const total = (s: ReturnType<typeof usageSeries>) => s.buckets.reduce((n, b) => n + b.output, 0);
    expect(total(before)).toBe(15); // two requests in the main file, one in the subagent's, 5 output tokens each
    fs.appendFileSync(file, lines([{ type: 'assistant', uuid: 'a9', requestId: 'r9', timestamp: at(6), message: { model: 'claude-opus-5', usage, content: [] } }]));
    expect(total(usageSeries(2))).toBe(20);
  });
});

describe('tailOf', () => {
  it('reads only the end of a big log', () => {
    const file = path.join(root(), 'run.log');
    fs.writeFileSync(file, 'x'.repeat(10_000) + 'THE END');
    expect(tailOf(file, 4000)).toHaveLength(4000);
    expect(tailOf(file, 4000).endsWith('THE END')).toBe(true);
    expect(tailOf(path.join(root(), 'missing.log'), 4000)).toBe('');
  });
});
