import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setSnapshot } from '../server/runner/board-snapshot';
import { nowSec, setDry } from '../server/runner/log';
import { sampleMachine, setReaders } from '../server/runner/machine';
import { pausedSeconds, pressure, resetPressure, resumeRun } from '../server/runner/pressure';
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
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const me = Number(alivePid());
/** The board the last tick read; set again on every tick, since the harness's config reloads drop the snapshot as a real reconfigure would. */
let board: ReturnType<typeof card>[] = [];
const tick = async (free: number) => {
  setSnapshot(board);
  memory = free;
  // Readings a minute apart: a trend is a matter of time, not of a count of readings.
  vi.setSystemTime(Date.now() + 60_000);
  await sampleMachine();
  pressure();
};
const stopped = (pid: number) => signals.some((s) => s.pid === -pid && s.signal === 'SIGSTOP');
const continued = (pid: number) => signals.some((s) => s.pid === -pid && s.signal === 'SIGCONT');

describe('pressure', () => {
  it('pauses by column — In Progress before Code Review before QA — then by card priority, and resumes in reverse', async () => {
    makeSession('issue', 1, { pid: alivePid(), 'state.json': { state: 'working' }, 'dev.pid': '4242\n' });
    makeSession('issue', 2, { pid: alivePid(), 'state.json': { state: 'working' } });
    makeSession('qa', 3, { pid: alivePid() });
    makeSession('approved', 9, { pid: alivePid(), issue: '5' });
    makeSession('issue', 4, { pid: alivePid(), 'state.json': { state: 'waiting' } }); // parked: no processes to pause
    const [d1, d2, d3, d9, d4] = [sessionDir('issue', 1), sessionDir('issue', 2), sessionDir('qa', 3), sessionDir('approved', 9), sessionDir('issue', 4)];
    board = [card(1, 'In Progress', { priority: 0 }), card(2, 'In Progress', { priority: 1 }), card(5, 'Code Review')];

    await tick(5);
    expect(signals).toHaveLength(0); // one reading is not a trend
    await tick(5);
    expect(exists(d2, 'paused')).toBe(true); // In Progress, the lower card priority
    expect(exists(d1, 'paused')).toBe(false);
    expect(readLog().join('\n')).toMatch(/paused issue-2 — machine busy: 5% memory free, under 10%/);
    await tick(5);
    await tick(5);
    expect(exists(d1, 'paused')).toBe(true);
    expect(stopped(4242)).toBe(true); // its dev server too
    expect(exists(d9, 'paused')).toBe(false);
    await tick(5);
    await tick(5);
    expect(exists(d9, 'paused')).toBe(true); // Code Review after every In Progress run
    expect(exists(d3, 'paused')).toBe(false);
    await tick(5);
    await tick(5);
    expect(exists(d3, 'paused')).toBe(true); // QA last of all
    expect(exists(d4, 'paused')).toBe(false);
    expect(JSON.parse(read(path.join(d3, 'paused')))).toMatchObject({ reason: 'machine busy: 5% memory free, under 10%' });

    signals.length = 0;
    await tick(50);
    expect(signals).toHaveLength(0);
    await tick(50);
    expect(exists(d3, 'paused')).toBe(false); // QA comes back first
    expect(exists(d9, 'paused')).toBe(true);
    expect(continued(me)).toBe(true);
    expect(readLog().join('\n')).toMatch(/resumed qa-3 — the machine has room again \(3 still paused\)/);
    await tick(50);
    await tick(50);
    expect(exists(d9, 'paused')).toBe(false);
    await tick(50);
    await tick(50);
    expect(exists(d1, 'paused')).toBe(false);
    expect(continued(4242)).toBe(true);
    expect(exists(d2, 'paused')).toBe(true);
    expect(pausedSeconds(d1)).toBeGreaterThanOrEqual(0);
    expect(exists(d1, 'paused_total')).toBe(true);
  });

  it('ranks an implement run by the column its card is in now — one sent back from Code Review outranks In Progress', async () => {
    makeSession('issue', 1, { pid: alivePid() });
    makeSession('issue', 2, { pid: alivePid() });
    const [d1, d2] = [sessionDir('issue', 1), sessionDir('issue', 2)];
    board = [card(1, 'Code Review', { priority: 2 }), card(2, 'In Progress', { priority: 0 })];
    await tick(5);
    await tick(5);
    expect(exists(d2, 'paused')).toBe(true);
    expect(exists(d1, 'paused')).toBe(false);
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
    expect(signals.some((s) => s.signal === undefined || s.signal === 'SIGTERM')).toBe(false); // 55 min of its own: within budget + grace
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

  it('sends no SIGCONT on Windows either — the name is ignored there and the process would be killed', () => {
    // `process.kill(pid, 'SIGCONT')` on Windows does not resume anything: the signal name is ignored and
    // the process is terminated. Resuming is what every stop path does first, so this must be a no-op.
    makeSession('issue', 3, { pid: alivePid(), paused: JSON.stringify({ since: nowSec() - 30, reason: 'memory' }) });
    const platform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      expect(resumeRun(sessionDir('issue', 3))).toBe(true); // the bookkeeping still happens
    } finally {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    }
    expect(signals).toHaveLength(0);
    expect(exists(sessionDir('issue', 3), 'paused')).toBe(false);
    expect(readLog().join('\n')).toMatch(/SIGCONT is not available on win32/);
  });
});
