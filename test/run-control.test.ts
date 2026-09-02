import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cfg } from '../server/config';
import { park, pausedUntil, reap, stop } from '../server/runner/run-control';
import { exitsOf } from '../server/runner/exits';
import { nowSec, setDry } from '../server/runner/log';
import { called, onGh, resetGh } from './gh-mock';
import { resetSpawn } from './child-process-mock';
import { configure, exists, makeSession, read, readLog, sessionDir, statePath, wipe } from './harness';

vi.mock('../server/runner/gh', () => import('./gh-mock'));
vi.mock('node:child_process', () => import('./child-process-mock'));

/**
 * What `triggers.test.ts` does not already reach through the re-exports: the live-run half of `stop`,
 * the states `reap` deliberately leaves alone, and `pausedUntil` itself. The board-facing behaviour of
 * `park` (blocking in place, the help mentions) is covered there and is not repeated here.
 */

/** Kills are stubbed out so a "live" session can be stopped without taking the test process with it. */
const stubKill = () => vi.spyOn(process, 'kill').mockImplementation(() => true);

/** Well past the budget and the kill grace, on Sloth's own `started` mark. */
const overBudget = () => String(nowSec() - (cfg().budgetMinutes + 20) * 60);

beforeEach(() => {
  configure({ maxActive: 2, maxAlive: 3, maxRetries: 2, budgetMinutes: 60 });
  wipe();
  resetGh();
  resetSpawn();
  setDry(false);
});

describe('stop, on a live issue run', () => {
  it('records how the run was ended, forgets its pid and parks the card with that record', async () => {
    const kill = stubKill();
    try {
      makeSession('issue', 7, {
        pid: '12345',
        'state.json': { state: 'working', step: '4', note: 'writing the tests' },
        'run.log': 'about to open the PR\n',
      });
      onGh(/project item-add/, 'ITEM');

      expect(await stop('issue', 7, 'stopped from the monitor', 'a human stopped this run.')).toBe(true);

      expect(exists(sessionDir('issue', 7), 'pid')).toBe(false);
      // The run never prints a final report when it is killed, so what it was doing is all there is —
      // recorded, spent on the parking comment below, and forgotten with it.
      expect(exitsOf(sessionDir('issue', 7))).toEqual([]);
      // The whole process group goes, so the run's subagents and servers go with it.
      const signalled = kill.mock.calls.filter(([, sig]) => sig !== 0).map(([pid]) => pid);
      expect(signalled).toContain(12345);
      expect(signalled).toContain(-12345);
      // …and the human gets the reason, the record under it, and the card in needs-help.
      expect(called(/issue comment 7 [\s\S]*a human stopped this run\./)).toHaveLength(1);
      expect(called(/issue comment 7 [\s\S]*stopped by Sloth: stopped from the monitor at step 4 \(writing the tests\)/)).toHaveLength(1);
      expect(called(/item-edit .*opt-help/)).toHaveLength(1);
      expect(readLog().join('\n')).toMatch(/#7 stopped: stopped from the monitor/);
    } finally {
      kill.mockRestore();
    }
  });

  it('signals nothing and touches no card in a dry run', async () => {
    const kill = stubKill();
    try {
      setDry(true);
      makeSession('issue', 7, { pid: '12345', 'state.json': { state: 'working' } });
      expect(await stop('issue', 7, 'stopped from the monitor', 'why')).toBe(true);
      expect(kill.mock.calls.filter(([, sig]) => sig !== 0)).toHaveLength(0);
      expect(exists(sessionDir('issue', 7), 'pid')).toBe(true);
      expect(called(/issue comment/)).toHaveLength(0);
      expect(readLog().join('\n')).toMatch(/dry-run: would stop issue-7: stopped from the monitor/);
    } finally {
      setDry(false);
      kill.mockRestore();
    }
  });

  it('has nothing to end for a session that was never started', async () => {
    expect(await stop('issue', 404, 'x', 'y')).toBe(false);
    expect(called(/issue comment/)).toHaveLength(0);
  });
});

describe('reap, on the runs it leaves alone', () => {
  it('leaves a waiting session past its budget running — it stopped to ask, it is not hung', async () => {
    const kill = stubKill();
    try {
      // A parked session waits `waitHours` for its answer, which is longer than a run's budget: killing
      // it on the budget clock would park every question the moment it was asked.
      makeSession('issue', 5, { pid: '12345', started: overBudget(), 'state.json': { state: 'waiting', step: 'Q', since: nowSec() } });
      makeSession('issue', 6, { pid: '12346', started: overBudget(), 'state.json': { state: 'done', since: nowSec() } });
      await reap();
      const logged = readLog().join('\n');
      expect(logged).not.toMatch(/#5 stopped/);
      expect(logged).not.toMatch(/#6 stopped/);
      expect(exists(sessionDir('issue', 5), 'pid')).toBe(true);
      expect(exists(sessionDir('issue', 6), 'pid')).toBe(true);
      expect(called(/issue comment/)).toHaveLength(0);
    } finally {
      kill.mockRestore();
    }
  });

  it('leaves the app of a dead run that got as far as a preview state alone', async () => {
    // `preview.json` is the session's hand-over and `preview-state.json` the server's record of the
    // tunnel it opened for it: either one means the app is up on purpose and `previews` owns it now.
    makeSession('issue', 1, { pid: '2000000000', 'state.json': { state: 'working' }, 'run.log': 'died\n', 'demo.db': 'sloth_1\n', 'preview-state.json': { url: 'https://x.trycloudflare.com' } });
    await reap();
    expect(exists(sessionDir('issue', 1), 'demo.db')).toBe(true);
    expect(called(/dropdb/)).toHaveLength(0);
  });

  it('skips a session directory with no pid file at all', async () => {
    makeSession('issue', 2, { 'state.json': { state: 'working' }, 'run.log': 'nothing here\n' });
    await reap();
    expect(exitsOf(sessionDir('issue', 2))).toEqual([]);
    expect(readLog()).toEqual([]);
  });
});

describe('pausedUntil', () => {
  it('is zero until a usage limit pauses the watcher, and the deadline after one', async () => {
    expect(pausedUntil()).toBe(0);
    makeSession('issue', 1, { pid: '2000000000', 'run.log': 'Claude AI usage limit reached|123\n' });
    await reap();
    expect(pausedUntil()).toBe(Number(read(statePath('paused_until'))));
    expect(pausedUntil()).toBeGreaterThan(nowSec() + 29 * 60);
  });

  it('reads zero back from an unreadable file rather than a NaN nothing compares against', () => {
    fs.mkdirSync(cfg().stateDir, { recursive: true });
    fs.writeFileSync(path.join(cfg().stateDir, 'paused_until'), 'soon');
    expect(pausedUntil()).toBe(0);
  });
});

describe('park', () => {
  it('forgets the record of the runs once it has been posted, so the next park starts clean', async () => {
    makeSession('issue', 9, { 'exits.json': JSON.stringify([{ at: nowSec(), how: 'the session ended on its own', tail: 'out of time' }]), retries: '2' });
    onGh(/project item-add/, 'ITEM');
    await park(9, 'it broke.', 'the details');
    expect(exists(sessionDir('issue', 9), 'exits.json')).toBe(false);
    expect(exists(sessionDir('issue', 9), 'retries')).toBe(false);
    expect(called(/issue comment 9 [\s\S]*it broke\.[\s\S]*the details/)).toHaveLength(1);
    expect(exists(sessionDir('issue', 9), 'blocked')).toBe(false);
  });
});
