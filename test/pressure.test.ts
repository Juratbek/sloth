import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setSnapshot } from '../server/runner/board-snapshot';
import { setDry } from '../server/runner/log';
import { sampleMachine, setReaders } from '../server/runner/machine';
import { pausedSeconds, pressure, resetPressure } from '../server/runner/pressure';
import { reap, stop } from '../server/runner/triggers';
import { resetGh } from './gh-mock';
import { alivePid, card, configure, exists, makeSession, read, readLog, sessionDir, wipe } from './harness';

vi.mock('../server/runner/gh', () => import('./gh-mock'));
vi.mock('node:child_process', () => import('./child-process-mock'));

/** Every signal sent, in order; `kill(pid, 0)` keeps its real meaning for the pid this test runs as. */
const signals: { pid: number; signal: string | number | undefined }[] = [];
let memory = 50;

beforeEach(() => {
  board = [];
  configure({ minFreeMemory: 10, minIdleCpu: 0, minIdleDisk: 0, budgetMinutes: 60 });
  wipe();
  resetGh();
  resetPressure();
  setDry(false);
  memory = 50;
  setReaders({ memoryFree: () => memory, cpuTimes: () => ({ idle: 0, total: 0 }), diskTimes: () => ({ busy: {}, total: 0 }), windowMs: 0 });
  signals.length = 0;
  vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
    if (signal === 0) {
      if (Math.abs(pid) === process.pid) return true;
      throw new Error('ESRCH');
    }
    signals.push({ pid, signal });
    return true;
  });
});
afterEach(() => vi.restoreAllMocks());

const me = Number(alivePid());
/** The board the last tick read; set again on every tick, since the harness's config reloads drop the snapshot as a real reconfigure would. */
let board: ReturnType<typeof card>[] = [];
const tick = async (free: number) => {
  setSnapshot(board);
  memory = free;
  await sampleMachine();
  pressure();
};
const stopped = (pid: number) => signals.some((s) => s.pid === -pid && s.signal === 'SIGSTOP');
const continued = (pid: number) => signals.some((s) => s.pid === -pid && s.signal === 'SIGCONT');

describe('pressure', () => {
  it('pauses the lowest-priority working run after two readings over the limit, one per tick, then resumes in reverse', async () => {
    makeSession('issue', 1, { pid: alivePid(), 'state.json': { state: 'working' }, 'dev.pid': '4242\n' });
    makeSession('issue', 2, { pid: alivePid(), 'state.json': { state: 'working' } });
    makeSession('qa', 3, { pid: alivePid() });
    makeSession('approved', 9, { pid: alivePid() }); // a review is never paused
    makeSession('issue', 4, { pid: alivePid(), 'state.json': { state: 'waiting' } }); // parked: no processes to pause
    const [d1, d2, d3, d9, d4] = [sessionDir('issue', 1), sessionDir('issue', 2), sessionDir('qa', 3), sessionDir('approved', 9), sessionDir('issue', 4)];
    board = [card(1, 'In Progress', { priority: 0 }), card(2, 'In Progress', { priority: 1 })];

    await tick(5);
    expect(signals).toHaveLength(0); // one reading is not a trend
    await tick(5);
    expect(exists(d3, 'paused')).toBe(true);
    expect(exists(d2, 'paused')).toBe(false);
    expect(readLog().join('\n')).toMatch(/paused qa-3 — machine busy: 5% memory free, under 10%/);
    await tick(5);
    await tick(5);
    expect(exists(d2, 'paused')).toBe(true); // the lower board priority goes before #1
    expect(exists(d1, 'paused')).toBe(false);
    await tick(5);
    await tick(5);
    expect(exists(d1, 'paused')).toBe(true);
    expect(stopped(4242)).toBe(true); // its dev server too
    expect(exists(d9, 'paused')).toBe(false);
    expect(exists(d4, 'paused')).toBe(false);
    expect(JSON.parse(read(path.join(d1, 'paused')))).toMatchObject({ reason: 'machine busy: 5% memory free, under 10%' });

    signals.length = 0;
    await tick(50);
    expect(signals).toHaveLength(0);
    await tick(50);
    expect(exists(d1, 'paused')).toBe(false); // the highest priority comes back first
    expect(exists(d2, 'paused')).toBe(true);
    expect(continued(me)).toBe(true);
    expect(continued(4242)).toBe(true);
    expect(readLog().join('\n')).toMatch(/resumed issue-1 — the machine has room again \(2 still paused\)/);
    expect(pausedSeconds(d1)).toBeGreaterThanOrEqual(0);
    expect(exists(d1, 'paused_total')).toBe(true);
  });

  it('a hold that clears between readings starts the count over', async () => {
    makeSession('issue', 1, { pid: alivePid() });
    await tick(5);
    await tick(50);
    await tick(5);
    expect(signals).toHaveLength(0);
  });

  it('stop wakes a paused run before killing it, and its paused time does not count against the budget', async () => {
    makeSession('issue', 1, { pid: alivePid(), 'state.json': { state: 'working', since: Math.floor(Date.now() / 1000) - 63 * 60 } });
    await tick(5);
    await tick(5);
    expect(exists(sessionDir('issue', 1), 'paused')).toBe(true);
    // 63 minutes in, but paused: pretend it has been paused for 10 of them.
    fs.writeFileSync(path.join(sessionDir('issue', 1), 'paused_total'), String(10 * 60));
    signals.length = 0;
    await reap();
    expect(signals.some((s) => s.signal === undefined || s.signal === 'SIGTERM')).toBe(false); // 53 min of its own: within budget + grace
    await stop('issue', 1, 'from the monitor', 'why');
    const order = signals.map((s) => s.signal);
    expect(order.indexOf('SIGCONT')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('SIGCONT')).toBeLessThan(order.findIndex((s) => s === undefined || s === 'SIGTERM'));
    expect(exists(sessionDir('issue', 1), 'paused')).toBe(false);
  });

  it('only logs in a dry run, and does nothing on Windows', async () => {
    makeSession('issue', 1, { pid: alivePid() });
    setDry(true);
    await tick(5);
    await tick(5);
    expect(signals).toHaveLength(0);
    expect(readLog().join('\n')).toMatch(/dry-run: would pause issue-1/);
    setDry(false);
    const platform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      await tick(5);
      await tick(5);
    } finally {
      Object.defineProperty(process, 'platform', { value: platform });
    }
    expect(signals).toHaveLength(0);
  });
});
