import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startLoop, stopLoop, tick } from '../server/runner/loop';
import { snapshot } from '../server/runner/board-snapshot';
import { machineLoad, setReaders } from '../server/runner/machine';
import { setDry } from '../server/runner/log';
import { onGh, resetGh } from './gh-mock';
import { resetSpawn } from './child-process-mock';
import { calmMachine, configure, readLog, wipe } from './harness';

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

  it('says how often it reads the machine when it starts watching', () => {
    configure({ machineSeconds: 10 });
    calmMachine();
    startLoop();
    expect(readLog().join('\n')).toMatch(/board 300s \/ comments 120s \/ machine 10s/);
  });
});
