import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { cfg } from '../server/config';
import { limitExit, usageLimit } from '../server/runner/limits';
import { configure, makeSession, sessionDir, wipe } from './harness';

describe('limitExit', () => {
  it('recognises the usage-limit phrasings on the exit path', () => {
    expect(limitExit('… working\nClaude AI usage limit reached|1234567')).toBe(true);
    expect(limitExit("You've hit your weekly limit")).toBe(true);
    expect(limitExit('You have reached your specified API usage limit')).toBe(true);
  });
  it('ignores a limit mentioned long before the end, or in a long report line', () => {
    const early = 'usage limit reached\n' + Array.from({ length: 6 }, (_, i) => `line ${i}`).join('\n');
    expect(limitExit(early)).toBe(false);
    expect(limitExit(`${'x'.repeat(300)} usage limit reached`)).toBe(false);
    expect(limitExit('The GitHub API rate limit is 5000 points per hour')).toBe(false);
  });
  it('is false for an empty or missing log', () => {
    expect(limitExit(undefined)).toBe(false);
    expect(limitExit('')).toBe(false);
  });
});

/** A run whose transcript is `records` and whose run.log is `runLog`; either may be left out. */
function run(issue: number, records: unknown[] | undefined, runLog = 'working on it\n'): string {
  const id = `sess-${issue}`;
  makeSession('issue', issue, { session_id: id, 'run.log': runLog });
  if (records) {
    fs.mkdirSync(cfg().transcriptsDir, { recursive: true });
    fs.writeFileSync(path.join(cfg().transcriptsDir, `${id}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
  return sessionDir('issue', issue);
}

const apiError = (body: unknown) => ({
  type: 'assistant',
  isApiErrorMessage: true,
  message: { content: [{ type: 'text', text: `API Error: ${JSON.stringify(body)}` }] },
});
const chatter = (n: number) => Array.from({ length: n }, (_, i) => ({ type: 'assistant', message: { content: [{ type: 'text', text: `step ${i}` }] } }));

describe('usageLimit', () => {
  beforeEach(() => {
    configure();
    wipe();
  });

  it('prefers the transcript: an API error naming the limit by its type', () => {
    const dir = run(1, [...chatter(2), apiError({ type: 'error', error: { type: 'rate_limit_error', message: 'quota' } })]);
    expect(usageLimit(dir)).toBe('structured');
  });

  it('reads a 429 status the same way, whatever prose came with it', () => {
    const dir = run(2, [{ type: 'result', is_error: true, error: { status: 429, message: 'too many requests' } }]);
    expect(usageLimit(dir)).toBe('structured');
  });

  it('falls back to the run log when the transcript says nothing structured', () => {
    const dir = run(3, [...chatter(3)], 'thinking\nClaude AI usage limit reached|1234567\n');
    expect(usageLimit(dir)).toBe('matched log text');
  });

  it('still works for a run with no transcript at all', () => {
    const dir = run(4, undefined, "You've hit your weekly limit\n");
    expect(usageLimit(dir)).toBe('matched log text');
  });

  it('pauses nothing for a run that ended on anything else', () => {
    // A tool result quoting GitHub's own rate limit is not Claude's — it is not even an error entry.
    const dir = run(5, [
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'API rate limit exceeded for user; status 429' }] } },
      ...chatter(1),
    ], 'the PR is open\n');
    expect(usageLimit(dir)).toBeUndefined();
  });

  it('ignores an error the session recovered from long before it ended', () => {
    const dir = run(6, [apiError({ type: 'error', error: { type: 'rate_limit_error' } }), ...chatter(8)]);
    expect(usageLimit(dir)).toBeUndefined();
  });

  it('is undefined for a run that left neither a transcript nor a log', () => {
    expect(usageLimit(run(7, undefined, ''))).toBeUndefined();
  });
});
