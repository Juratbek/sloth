import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { machineHold, machineLoad, sampleMachine, setReaders } from '../server/runner/machine';
import { pickup } from '../server/runner/triggers';
import { tick } from '../server/runner/loop';
import { setDry } from '../server/runner/log';
import { onGh, resetGh } from './gh-mock';
import { resetSpawn, spawned } from './child-process-mock';
import { calmMachine, card, configure, readLog, wipe } from './harness';

vi.mock('../server/runner/gh', () => import('./gh-mock'));
vi.mock('node:child_process', () => import('./child-process-mock'));

/**
 * A machine with `memory` percent available whose CPU is `idle` percent idle over every window and whose
 * busiest disk is `disk` percent idle — the other disk sits idle, so the busiest one is what counts.
 */
function machine(memory: number, idle: number, disk = 100) {
  let tick = 0;
  let diskTick = 0;
  setReaders({
    memoryFree: () => memory,
    cpuTimes: () => ({ idle: (tick++ * 1000 * idle) / 100, total: (tick - 1) * 1000 + 1 }),
    diskTimes: () => {
      const total = diskTick++ * 1000;
      return { busy: { sda: (total * (100 - disk)) / 100, sdb: 0 }, total };
    },
    windowMs: 0,
  });
}

beforeEach(() => {
  configure({ minFreeMemory: 10, minIdleCpu: 5, minIdleDisk: 10 });
  wipe();
  resetGh();
  resetSpawn();
  setDry(false);
});
afterEach(() => calmMachine());

describe('the machine limit', () => {
  it('holds new sessions while memory, CPU or disk is short, and says which', async () => {
    machine(7, 50);
    await sampleMachine();
    expect(machineHold()).toBe('machine busy: 7% memory free, under 10%');
    machine(40, 3);
    await sampleMachine();
    expect(machineHold()).toBe('machine busy: 3% CPU idle, under 5%');
    machine(40, 50, 4);
    await sampleMachine();
    expect(machineHold()).toBe('machine busy: 4% disk idle, under 10%');
    machine(40, 50, 60);
    await sampleMachine();
    expect(machineHold()).toBeUndefined();
    expect(machineLoad()).toMatchObject({ memoryFree: 40, cpuIdle: 50, diskIdle: 60 });
  });
  it('a machine with no disk reading counts as idle', async () => {
    calmMachine();
    await sampleMachine();
    expect(machineLoad()).toMatchObject({ diskIdle: 100 });
  });
  it('holds nothing on a platform whose disk cannot be measured, and reports no figure for it', async () => {
    // macOS: `ioreg` only offers the summed latency of every I/O, which outruns the clock as soon as
    // requests overlap — a write burst read as 630% busy, so 0% idle, and held every launch.
    setReaders({
      memoryFree: () => 40,
      cpuTimes: () => ({ idle: 0, total: 0 }),
      diskTimes: () => ({ busy: {}, total: performance.now(), unavailable: true }),
      windowMs: 0,
    });
    await sampleMachine();
    expect(machineHold()).toBeUndefined();
    expect(machineLoad()?.diskIdle).toBeUndefined();
  });
  it('a 0 turns a check off', async () => {
    configure({ minFreeMemory: 0, minIdleCpu: 0, minIdleDisk: 0 });
    machine(1, 0, 0);
    await sampleMachine();
    expect(machineHold()).toBeUndefined();
  });
  it('queues a pickup with the reason instead of launching', async () => {
    machine(7, 50);
    await sampleMachine();
    await pickup([card(5, 'Todo')]);
    expect(spawned).toHaveLength(0);
    expect(readLog().at(-1)).toMatch(/#5 queued \(machine busy: 7% memory free, under 10%\)/);
  });
  it('is read on every tick, logged once when it starts and once when it clears', async () => {
    onGh(/items\(first: 100/, { data: { node: { items: { pageInfo: { hasNextPage: false }, nodes: [] } } } });
    machine(7, 50);
    await tick({ board: true });
    await tick({ comments: true });
    expect(readLog().filter((l) => /machine busy/.test(l))).toHaveLength(1);
    machine(40, 50);
    await tick({ board: true });
    expect(readLog().at(-1)).toMatch(/machine load cleared/);
  });
});
