import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isDry, setDry, withDry } from '../server/runner/log';
import { tick } from '../server/runner/loop';
import { reap, stop } from '../server/runner/run-control';
import { called, onGh, resetGh } from './gh-mock';
import { resetSpawn } from './child-process-mock';
import fs from 'node:fs';
import { alivePid, configure, exists, makeSession, readLog, runRef, sessionDir, statePath, wipe } from './harness';

vi.mock('../server/runner/gh', () => import('./gh-mock'));
vi.mock('node:child_process', () => import('./child-process-mock'));

/**
 * Dryness belongs to the call. It used to be a flag on the module, which `POST /api/tick?dry=1` held for
 * the length of the whole tick — so a stop the human asked for in that window read the flag as its own,
 * did nothing, and said it had.
 */

beforeEach(() => {
  configure();
  wipe();
  resetGh();
  resetSpawn();
  setDry(false);
});

describe('withDry', () => {
  it('holds two concurrent calls apart, whatever order they interleave in', async () => {
    const seen: string[] = [];
    const step = () => new Promise((r) => setTimeout(r, 1));
    const dryCall = withDry(async () => {
      seen.push(`dry start ${isDry()}`);
      await step();
      seen.push(`dry after await ${isDry()}`);
    });
    const realCall = (async () => {
      seen.push(`real start ${isDry()}`);
      await step();
      seen.push(`real after await ${isDry()}`);
    })();
    await Promise.all([dryCall, realCall]);
    expect(seen.sort()).toEqual(['dry after await true', 'dry start true', 'real after await false', 'real start false']);
    // And nothing of it is left on the process afterwards.
    expect(isDry()).toBe(false);
  });

  it('passes the value back and leaves nothing behind when the call throws', async () => {
    expect(await withDry(async () => 'answer')).toBe('answer');
    await expect(withDry(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(isDry()).toBe(false);
  });

  it('is still on for the whole process while SLOTH_DRY_RUN says so', () => {
    setDry(true);
    try {
      expect(isDry()).toBe(true);
    } finally {
      setDry(false);
    }
  });
});

describe('a dry reap', () => {
  it('keeps the markers of a run that died without a verdict, and tears nothing down', async () => {
    // `bookRun`, the pid file and the pause files all checked for dryness; the marker removal, the exit
    // record and the sweep did not. `POST /api/tick?dry=1` against a Sloth with a review that had just
    // died deleted `state/approved/<pr>-<sha>`, so the next real tick paid for a second review of the
    // same commit — and for a QA run it killed the recorded servers, ran `dropdb` and freed the slot.
    fs.mkdirSync(statePath('approved'), { recursive: true });
    fs.writeFileSync(statePath('approved', '5-aaa'), '');
    makeSession('approved', 5, { pid: '2000000000', sha: 'aaa', 'state.json': { state: 'working' }, 'run.log': 'died\n' });
    const qa = makeSession('qa', 6, { pid: '2000000000', sha: 'bbb', 'state.json': { state: 'working' }, 'dev.pid': '4242\n', 'demo.db': 'sloth_qa_6\n', 'run.log': 'died\n' });
    fs.mkdirSync(statePath('qa'), { recursive: true });
    fs.writeFileSync(statePath('qa', '6-bbb'), '');
    const issue = makeSession('issue', 7, { pid: '2000000000', 'state.json': { state: 'working' }, 'run.log': 'died\n' });

    await withDry(() => reap());

    expect(exists(statePath('approved', '5-aaa'))).toBe(true);
    expect(exists(statePath('qa', '6-bbb'))).toBe(true);
    expect(exists(qa, 'demo.db')).toBe(true);
    expect(called(/dropdb/)).toHaveLength(0);
    expect(exists(issue, 'exits.json')).toBe(false);
    expect(exists(issue, 'pid')).toBe(true);
    expect(readLog().join('\n')).toMatch(/dry-run: would sweep up what qa-6 left running/);
  });
});

describe('a dry tick', () => {
  it('does not turn a real stop that arrives in its window into a no-op', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
      if (signal === 0 && Math.abs(pid) !== process.pid) throw new Error('ESRCH');
      return true;
    });
    try {
      makeSession('issue', 7, { pid: alivePid(), 'state.json': { state: 'working' }, 'run.log': 'working\n' });
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      onGh(/items\(first: 100/, async () => {
        await held;
        return { data: { node: { items: { pageInfo: { hasNextPage: false }, nodes: [] } } } };
      });
      onGh(/project item-add/, 'ITEM');
      const ticking = tick({ board: true, dryRun: true });
      await new Promise((r) => setImmediate(r));
      // The human's stop, in the window the dry tick used to own: it kills, it forgets the pid, it parks.
      expect(await stop(runRef('issue', 7), 'stopped from the monitor', 'a human stopped this run.')).toBe(true);
      release();
      await ticking;
      expect(exists(sessionDir('issue', 7), 'pid')).toBe(false);
      const logged = readLog().join('\n');
      expect(logged).toMatch(/#7 stopped: stopped from the monitor/);
      expect(logged).not.toMatch(/dry-run: would stop/);
    } finally {
      kill.mockRestore();
    }
  });
});
