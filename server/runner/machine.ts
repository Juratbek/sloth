import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { cfg } from '../config';
import type { MachineLoad } from '../types';

/**
 * How much of the machine is left for a new session. Sloth holds new work back when the memory
 * left drops under `minFreeMemory` percent, the CPU idle under `minIdleCpu` percent or the disk idle
 * under `minIdleDisk` percent — a claude run with its subagents, a booted app and a browser is what
 * pushes a busy PC over the edge, and on a spinning disk the I/O of a few of them at once is what
 * pins Task Manager's disk at 100%.
 */
export interface Readers {
  /** Memory available to a new process, in percent of the total. */
  memoryFree: () => number;
  /** Aggregate CPU times so far; idle over a window is the difference of two samples. */
  cpuTimes: () => { idle: number; total: number };
  /** Milliseconds each disk has spent busy so far, by disk, and a clock in ms to measure the window by. */
  diskTimes: () => DiskTimes;
  /** How long the first reading after a start watches the CPU and disk, ms. */
  windowMs?: number;
}
export interface DiskTimes {
  busy: Record<string, number>;
  total: number;
}

/**
 * The memory a new process can take, as the OS itself counts it: `MemAvailable` on Linux, the kernel's
 * memory-pressure level on macOS (`os.freemem()` there is only the untouched pages, a few percent on any
 * Mac that has been up for an hour). Elsewhere the free pages have to do.
 */
export function memoryFreePercent(): number {
  const percent = (part: number, total: number) => (total > 0 ? Math.round((part / total) * 100) : 100);
  try {
    if (process.platform === 'linux') {
      const info = fs.readFileSync('/proc/meminfo', 'utf8');
      const kb = (key: string) => Number(new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(info)?.[1] ?? 0);
      const total = kb('MemTotal');
      const available = kb('MemAvailable') || kb('MemFree') + kb('Buffers') + kb('Cached');
      if (total > 0) return percent(available, total);
    } else if (process.platform === 'darwin') {
      const level = Number(execFileSync('sysctl', ['-n', 'kern.memorystatus_level'], { encoding: 'utf8', timeout: 2000 }).trim());
      if (Number.isFinite(level)) return Math.max(0, Math.min(100, level));
    }
  } catch {
    /* fall back to what node knows */
  }
  return percent(os.freemem(), os.totalmem());
}

export function cpuTimes(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq + cpu.times.idle;
  }
  return { idle, total };
}

const ms = (n: number) => (Number.isFinite(n) ? n : 0);

/**
 * How long each whole disk has been busy, as the OS counts it: `io_ticks` in `/proc/diskstats` on Linux,
 * the block-storage drivers' read and write time on macOS (`ioreg`), the perf counters' busy time on
 * Windows — the same figure Task Manager's *Disk* column comes from. Nothing anywhere else, which reads
 * as an idle disk.
 */
export function diskTimes(): DiskTimes {
  const busy: Record<string, number> = {};
  try {
    if (process.platform === 'linux') {
      // major minor name reads … writes … ios_in_progress io_ticks …; whole disks only, not partitions or loops.
      for (const line of fs.readFileSync('/proc/diskstats', 'utf8').split('\n')) {
        const f = line.trim().split(/\s+/);
        const name = f[2];
        if (!name || f.length < 13 || !/^(sd[a-z]+|hd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/.test(name)) continue;
        busy[name] = ms(Number(f[12]));
      }
    } else if (process.platform === 'darwin') {
      const out = execFileSync('ioreg', ['-r', '-c', 'IOBlockStorageDriver', '-w0'], { encoding: 'utf8', timeout: 2000 });
      let n = 0;
      for (const [, stats] of out.matchAll(/"Statistics" = \{([^}]*)\}/g)) {
        const ns = (key: string) => Number(new RegExp(`"Total Time \\(${key}\\)"=(\\d+)`).exec(stats)?.[1] ?? 0);
        busy[`disk${n++}`] = ms((ns('Read') + ns('Write')) / 1e6);
      }
    } else if (process.platform === 'win32') {
      // Raw counters: PercentIdleTime and the timestamp are both in 100ns ticks, so busy = timestamp - idle.
      const out = execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "Get-CimInstance Win32_PerfRawData_PerfDisk_PhysicalDisk | Where-Object Name -ne '_Total' | ForEach-Object { $_.Name + '|' + $_.PercentIdleTime + '|' + $_.Timestamp_Sys100NS }",
        ],
        { encoding: 'utf8', timeout: 5000, windowsHide: true },
      );
      for (const line of out.split(/\r?\n/)) {
        const [name, idle, stamp] = line.trim().split('|');
        if (name && idle && stamp) busy[name] = ms((Number(stamp) - Number(idle)) / 1e4);
      }
    }
  } catch {
    /* no reading: the disk counts as idle */
  }
  return { busy, total: performance.now() };
}

const REAL: Readers = { memoryFree: memoryFreePercent, cpuTimes, diskTimes, windowMs: 500 };
let readers = REAL;
/** Tests stand in their own readers; `undefined` puts the real ones back. */
export function setReaders(r?: Readers): void {
  readers = r ?? REAL;
  previous = undefined;
  last = undefined;
}

let previous: { cpu: { idle: number; total: number }; disk: DiskTimes } | undefined;
let last: MachineLoad | undefined;

/** The idle percent of the busiest disk over the window between two readings; 100 with no disk at all. */
function diskIdlePercent(before: DiskTimes, now: DiskTimes): number {
  const elapsed = now.total - before.total;
  if (elapsed <= 0) return 100;
  let busiest = 0;
  for (const [name, ticks] of Object.entries(now.busy)) {
    const was = before.busy[name];
    if (was === undefined) continue;
    busiest = Math.max(busiest, ticks - was);
  }
  return Math.max(0, Math.min(100, Math.round(100 - (busiest / elapsed) * 100)));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One reading, taken every `machineSeconds` and again on a tick before anything may launch. The CPU and
 * disk idle are averaged over the window since the previous reading — the first one after a start
 * measures a short window of its own.
 */
export async function sampleMachine(): Promise<MachineLoad> {
  const { minFreeMemory, minIdleCpu, minIdleDisk } = cfg();
  let before = previous;
  if (!before) {
    before = { cpu: readers.cpuTimes(), disk: readers.diskTimes() };
    if ((minIdleCpu > 0 || minIdleDisk > 0) && readers.windowMs) await sleep(readers.windowMs);
  }
  const now = { cpu: readers.cpuTimes(), disk: readers.diskTimes() };
  previous = now;
  const total = now.cpu.total - before.cpu.total;
  const cpuIdle = total > 0 ? Math.round(((now.cpu.idle - before.cpu.idle) / total) * 100) : 100;
  const diskIdle = diskIdlePercent(before.disk, now.disk);
  const memoryFree = readers.memoryFree();
  const holds: string[] = [];
  if (minFreeMemory > 0 && memoryFree < minFreeMemory) holds.push(`${memoryFree}% memory free, under ${minFreeMemory}%`);
  if (minIdleCpu > 0 && cpuIdle < minIdleCpu) holds.push(`${cpuIdle}% CPU idle, under ${minIdleCpu}%`);
  if (minIdleDisk > 0 && diskIdle < minIdleDisk) holds.push(`${diskIdle}% disk idle, under ${minIdleDisk}%`);
  last = { memoryFree, cpuIdle, diskIdle, at: Date.now(), hold: holds.length ? `machine busy: ${holds.join(', ')}` : undefined };
  return last;
}

/** The last reading; nothing before the first tick. */
export const machineLoad = (): MachineLoad | undefined => last;

/** Why a session must not start now — the machine has too little memory, CPU or disk left — or nothing. */
export const machineHold = (): string | undefined => last?.hold;
