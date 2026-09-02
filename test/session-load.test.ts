import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sampleSessions, setProcessReaders, type Process } from '../server/runner/session-load';
import { listSessionDirs } from '../server/watcher';
import { alivePid, configure, makeSession, noProcesses, wipe } from './harness';

/** One reader over a fixed list of readings; each call serves the next and moves the clock on. */
function readings(frames: Process[][]) {
  let i = -1;
  let at = 0;
  setProcessReaders({ processes: () => frames[i], now: () => at });
  return (seconds = 2) => {
    i++;
    if (i > 0) at += seconds * 1000;
    return sampleSessions([100]);
  };
}

const proc = (pid: number, ppid: number, cpuSeconds: number, rss: number, io?: [number, number]): Process => ({
  pid,
  ppid,
  cpuSeconds,
  rss,
  ...(io ? { readBytes: io[0], writeBytes: io[1] } : {}),
});

beforeEach(() => {
  configure();
  wipe();
});
afterEach(() => noProcesses());

describe('what a session is taking of the machine', () => {
  it('says nothing until it has read the process table twice', () => {
    const next = readings([[proc(100, 1, 10, 1024)], [proc(100, 1, 12, 1024)]]);
    expect(next().get(100)).toBeUndefined();
    expect(next().get(100)).toBeDefined();
  });

  it('sums the whole process tree — the run, what it started and what those started', () => {
    const next = readings([
      [proc(100, 1, 0, 100 << 20), proc(200, 100, 0, 50 << 20), proc(300, 200, 0, 25 << 20), proc(999, 1, 0, 1 << 30)],
      [proc(100, 1, 1, 100 << 20), proc(200, 100, 2, 50 << 20), proc(300, 200, 1, 25 << 20), proc(999, 1, 9, 1 << 30)],
    ]);
    next();
    const load = next(2).get(100)!;
    // 4 CPU-seconds over a 2s window is two cores busy; the unrelated pid 999 is not in this tree.
    expect(load.cpu).toBe(200);
    expect(load.memory).toBe(175 << 20);
    expect(load.processes).toBe(3);
  });

  it('counts a process born inside the window in full, since it spent that time inside it', () => {
    const next = readings([[proc(100, 1, 0, 0)], [proc(100, 1, 0, 0), proc(201, 100, 4, 0)]]);
    next();
    expect(next(4).get(100)!.cpu).toBe(100);
  });

  it('turns the disk counters into bytes a second, and leaves them out where the OS has none', () => {
    const withIo = readings([
      [proc(100, 1, 0, 0, [0, 0]), proc(200, 100, 0, 0, [1000, 500])],
      [proc(100, 1, 0, 0, [4000, 0]), proc(200, 100, 0, 0, [1000, 2500])],
    ]);
    withIo();
    expect(withIo(2).get(100)).toMatchObject({ readBytes: 2000, writeBytes: 1000 });

    const noIo = readings([[proc(100, 1, 0, 0)], [proc(100, 1, 0, 0)]]);
    noIo();
    const load = noIo(2).get(100)!;
    expect(load.readBytes).toBeUndefined();
    expect(load.writeBytes).toBeUndefined();
  });

  it('primes the disk counters on the first reading, and asks only the session tree for them', () => {
    let at = 0;
    const counters = new Map([
      [100, 1_000_000],
      [999, 5_000_000],
    ]);
    const asked: number[] = [];
    setProcessReaders({
      processes: () => [proc(100, 1, 0, 0), proc(999, 1, 0, 0)],
      io: (pid) => {
        asked.push(pid);
        return { readBytes: counters.get(pid)!, writeBytes: 0 };
      },
      now: () => at,
    });
    sampleSessions([100]);
    expect(asked).toEqual([100]);
    counters.set(100, 1_002_000);
    at = 2000;
    // The megabyte this process read before Sloth ever looked is not this window's: only the 2 kB since.
    expect(sampleSessions([100]).get(100)).toMatchObject({ readBytes: 1000 });
  });

  it('drops a session whose process is gone', () => {
    const next = readings([[proc(100, 1, 0, 0)], [proc(100, 1, 1, 0)], []]);
    next();
    expect(next().get(100)).toBeDefined();
    expect(next().get(100)).toBeUndefined();
  });

  it('serves the previous answer rather than reading again within a second', () => {
    let reads = 0;
    let at = 0;
    setProcessReaders({
      processes: () => {
        reads++;
        return [proc(100, 1, reads, 0)];
      },
      now: () => at,
    });
    sampleSessions([100]);
    at += 2000;
    sampleSessions([100]);
    expect(reads).toBe(2);
    at += 100;
    sampleSessions([100]);
    expect(reads).toBe(2);
  });
});

describe('the load on a session row', () => {
  it('is attached to a live run and to no other', () => {
    makeSession('issue', 5, { pid: alivePid() });
    makeSession('issue', 6, { pid: '999999' });
    const pid = process.pid;
    let at = 0;
    setProcessReaders({ processes: () => [proc(pid, 1, at / 1000, 64 << 20)], now: () => at });
    listSessionDirs();
    at = 2000;
    const dirs = listSessionDirs();
    expect(dirs.find((d) => d.target === 5)!.load).toMatchObject({ cpu: 100, memory: 64 << 20, processes: 1 });
    expect(dirs.find((d) => d.target === 6)!.load).toBeUndefined();
  });
});
