import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { exitReport, lastRun, recordExit, runHeader } from '../server/runner/exits';
import { limitExit } from '../server/runner/limits';
import { configure, makeSession, read, wipe } from './harness';

beforeEach(() => {
  configure();
  wipe();
});

describe('lastRun', () => {
  it('returns what follows the newest header, or the whole log from before headers existed', () => {
    expect(lastRun(undefined)).toBe('');
    expect(lastRun('old style\nlog\n')).toBe('old style\nlog\n');
    expect(lastRun(`${runHeader('opus')}one\n${runHeader('opus')}two\nthree\n`)).toBe('two\nthree\n');
    expect(lastRun(runHeader('opus').trimEnd())).toBe('');
  });
  it('keeps limitExit from re-reading the limit a previous run hit', () => {
    expect(limitExit(`${runHeader('opus')}Claude AI usage limit reached|1\n`)).toBe(true);
    expect(limitExit(`${runHeader('opus')}Claude AI usage limit reached|1\n${runHeader('opus')}`)).toBe(false);
  });
});

describe('recordExit / exitReport', () => {
  it('keeps the state and the end of the last output, and renders one section per run', () => {
    const dir = makeSession('issue', 3, {
      'state.json': { state: 'working', step: '5', note: 'review round 2' },
      'run.log': `${runHeader('opus')}${'x'.repeat(2000)}\nLeft: the tests.\n`,
    });
    const e = recordExit(dir, 'the session ended on its own');
    expect(e).toMatchObject({ step: '5', note: 'review round 2', how: 'the session ended on its own' });
    expect(e.tail.startsWith('…')).toBe(true);
    expect(e.tail.endsWith('Left: the tests.')).toBe(true);
    expect(e.tail.length).toBe(1501);
    recordExit(dir, 'stopped by Sloth: hung past the budget');
    expect(JSON.parse(read(path.join(dir, 'exits.json')))).toHaveLength(2);
    const report = exitReport(dir);
    expect(report).toContain('<summary>Run 1 of 2 — the session ended on its own at step 5 (review round 2), ');
    expect(report).toContain('<summary>Run 2 of 2 — stopped by Sloth: hung past the budget at step 5 (review round 2), ');
    expect(report).toContain('```\n…');
  });
  it('is empty with nothing recorded, and does not break out of its code fence', () => {
    const dir = makeSession('issue', 4, { 'run.log': 'a ``` fence\n' });
    expect(exitReport(dir)).toBe('');
    recordExit(dir, 'x');
    expect(exitReport(dir)).toContain("a ''' fence");
  });
});
