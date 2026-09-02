import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loopStatus, startLoop, stopLoop, tick } from '../server/runner/loop';
import { handleSetup } from '../server/setup';
import { cfg } from '../server/config';
import { snapshot } from '../server/runner/board-snapshot';
import { machineLoad, setReaders } from '../server/runner/machine';
import { setDry } from '../server/runner/log';
import { onGh, resetGh } from './gh-mock';
import { resetSpawn } from './child-process-mock';
import { baseConfig, calmMachine, configure, readLog, wipe } from './harness';

vi.mock('../server/runner/gh', () => import('./gh-mock'));
vi.mock('node:child_process', () => import('./child-process-mock'));

const board = (numbers: number[]) => ({
  data: {
    node: {
      items: {
        pageInfo: { hasNextPage: false },
        nodes: numbers.map((n) => ({
          fieldValueByName: { name: 'Todo' },
          content: { __typename: 'Issue', number: n, title: `Issue ${n}`, labels: { nodes: [] }, assignees: { nodes: [{ login: 'bob' }] } },
        })),
      },
    },
  },
});

beforeEach(() => {
  configure();
  wipe();
  resetGh();
  resetSpawn();
  setDry(false);
});

describe('a board tick', () => {
  it('holds a config save until the tick in flight is over, so no tick straddles two configs', async () => {
    // A tick reads `cfg()` lazily at every step. Saving the wizard underneath one used to write the old
    // board's item ids with the new board's field ids, and repopulate — with cards from a board Sloth no
    // longer watches — the snapshot `reloadConfig` had just cleared. Here the tick finishes on the old
    // config, and the save that follows leaves the snapshot empty for the new board's first tick to fill.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    onGh(/items\(first: 100/, async () => {
      await held;
      return board([5]);
    });
    const ticking = tick({ board: true });
    await new Promise((r) => setImmediate(r));
    expect(loopStatus().ticking).toBe(true);
    const saving = handleSetup('/api/setup/config', 'POST', baseConfig({ repo: 'acme/other' }));
    release();
    await Promise.all([ticking, saving]);
    try {
      expect(cfg().repo).toBe('acme/other');
      expect(snapshot()).toBeUndefined();
    } finally {
      stopLoop();
    }
  });

  it('keeps the board it read, so the home panel needs no fetch of its own', async () => {
    onGh(/items\(first: 100/, board([5, 6]));
    await tick({ board: true });
    expect(snapshot()?.items.map((i) => i.number)).toEqual([5, 6]);
  });

  it('keeps it in a dry run too — reading the board is harmless', async () => {
    onGh(/items\(first: 100/, board([9]));
    await tick({ board: true, dryRun: true });
    expect(snapshot()?.items.map((i) => i.number)).toEqual([9]);
  });

  it('leaves the last one alone when the read fails', async () => {
    onGh(/items\(first: 100/, board([1]));
    await tick({ board: true });
    onGh(/items\(first: 100/, { ok: false, out: '', err: 'HTTP 502' });
    await tick({ board: true });
    expect(snapshot()?.items.map((i) => i.number)).toEqual([1]);
  });
});

describe('the machine timer', () => {
  afterEach(() => {
    stopLoop();
    vi.useRealTimers();
  });

  it('reads the machine between two board polls, so a hold is seen in seconds and not in minutes', async () => {
    vi.useFakeTimers();
    configure({ machineSeconds: 10, boardSeconds: 300, commentSeconds: 300, minFreeMemory: 10 });
    let free = 50;
    setReaders({ memoryFree: () => free, cpuTimes: () => ({ idle: 0, total: 0 }), diskTimes: () => ({ busy: {}, total: 0 }), windowMs: 0 });
    startLoop();
    // Past the first board tick (5 s) and comment tick (20 s), which read the machine themselves; the next
    // ones are 300 s away, so from here only the machine timer can be reading.
    await vi.advanceTimersByTimeAsync(21_000);
    expect(machineLoad()?.memoryFree).toBe(50);
    free = 7;
    await vi.advanceTimersByTimeAsync(12_000);
    expect(machineLoad()?.memoryFree).toBe(7);
    expect(readLog().join('\n')).toMatch(/machine busy: 7% memory free, under 10% — no new sessions until it clears/);
    free = 50;
    await vi.advanceTimersByTimeAsync(12_000);
    expect(readLog().at(-1)).toMatch(/machine load cleared/);
  });

  it('arms one board timer when the settings are saved mid-tick, not two', async () => {
    vi.useFakeTimers();
    configure({ boardSeconds: 60, commentSeconds: 3600, machineSeconds: 3600 });
    calmMachine();
    let boards = 0;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    onGh(/items\(first: 100/, async () => {
      boards++;
      await held;
      return board([]);
    });
    startLoop();
    // The first board tick (5 s in) starts and stops inside the board read.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(boards).toBe(1);
    // Saving the settings restarts the loop while that tick is still in flight. Its `.finally` then runs
    // against a set of timers that is gone: it belongs to the old generation and must not arm one of its own.
    startLoop();
    release();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(boards).toBe(2);
    // One read per boardSeconds from here — the orphaned chain would have added its own at 60 s.
    await vi.advanceTimersByTimeAsync(61_000);
    expect(boards).toBe(3);
  });

  it('says how often it reads the machine when it starts watching', () => {
    configure({ machineSeconds: 10 });
    calmMachine();
    startLoop();
    expect(readLog().join('\n')).toMatch(/board 300s \/ comments 120s \/ machine 10s/);
  });
});
