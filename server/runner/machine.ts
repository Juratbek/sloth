import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { cfg } from '../config';
import type { MachineLoad } from '../types';

/**
 * How much of the machine is left for a new session. Sloth holds new work back when the memory
 * left drops under `minFreeMemory` percent or the CPU idle under `minIdleCpu` percent — a claude run
 * with its subagents, a booted app and a browser is what pushes a busy PC over the edge.
 */
export interface Readers {
  /** Memory available to a new process, in percent of the total. */
  memoryFree: () => number;
  /** Aggregate CPU times so far; idle over a window is the difference of two samples. */
  cpuTimes: () => { idle: number; total: number };
  /** How long the first reading after a start watches the CPU, ms. */
  windowMs?: number;
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

const REAL: Readers = { memoryFree: memoryFreePercent, cpuTimes, windowMs: 500 };
let readers = REAL;
/** Tests stand in their own readers; `undefined` puts the real ones back. */
export function setReaders(r?: Readers): void {
  readers = r ?? REAL;
  previous = undefined;
  last = undefined;
}

let previous: { idle: number; total: number } | undefined;
let last: MachineLoad | undefined;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One reading per tick, before anything may launch. The CPU idle is averaged over the window since
 * the previous tick — the first reading after a start measures a short window of its own.
 */
export async function sampleMachine(): Promise<MachineLoad> {
  const { minFreeMemory, minIdleCpu } = cfg();
  let before = previous;
  if (!before) {
    before = readers.cpuTimes();
    if (minIdleCpu > 0 && readers.windowMs) await sleep(readers.windowMs);
  }
  const now = readers.cpuTimes();
  previous = now;
  const total = now.total - before.total;
  const cpuIdle = total > 0 ? Math.round(((now.idle - before.idle) / total) * 100) : 100;
  const memoryFree = readers.memoryFree();
  const holds: string[] = [];
  if (minFreeMemory > 0 && memoryFree < minFreeMemory) holds.push(`${memoryFree}% memory free, under ${minFreeMemory}%`);
  if (minIdleCpu > 0 && cpuIdle < minIdleCpu) holds.push(`${cpuIdle}% CPU idle, under ${minIdleCpu}%`);
  last = { memoryFree, cpuIdle, at: Date.now(), hold: holds.length ? `machine busy: ${holds.join(', ')}` : undefined };
  return last;
}

/** The last reading; nothing before the first tick. */
export const machineLoad = (): MachineLoad | undefined => last;

/** Why a session must not start now — the machine has too little memory or CPU left — or nothing. */
export const machineHold = (): string | undefined => last?.hold;
