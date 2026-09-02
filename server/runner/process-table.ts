import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

/**
 * The machine's process table, as each OS gives it up: every process with its parent, its resident
 * memory, the CPU time it has used and — where the OS keeps the counter — the bytes it has moved to
 * and from the disk. Reading it is all this module does; `session-load.ts` turns two readings into
 * the rates one session's tree is running at.
 */

/** One process as the OS reports it. `cpuSeconds` and the byte counts are totals since it started. */
export interface Process {
  pid: number;
  ppid: number;
  /** Resident memory, bytes. */
  rss: number;
  /** CPU time used so far, seconds. */
  cpuSeconds: number;
  /** Bytes read from and written to the disk so far; absent where the OS does not say (macOS). */
  readBytes?: number;
  writeBytes?: number;
}
export interface Readers {
  /** Every process on the machine. An empty list reads as "nothing measurable here". */
  processes: () => Process[];
  /**
   * The byte counters of one process, where they cost a read of their own — `/proc/<pid>/io` on Linux.
   * Only the processes inside a session's tree are asked, so a busy machine is not read end to end.
   */
  io?: (pid: number) => { readBytes: number; writeBytes: number } | undefined;
  now?: () => number;
}

const num = (s: string | undefined) => {
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
};

/**
 * `/proc/<pid>/stat` directly: the parent, the CPU ticks and the resident pages. The command name may
 * hold spaces and brackets, so the fields are counted from the last `)` rather than from the start.
 */
function linuxProcesses(): Process[] {
  const ticks = 100; // USER_HZ; constant on every Linux Node runs on.
  const page = 4096;
  const out: Process[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync('/proc');
  } catch {
    return out;
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let stat: string;
    try {
      stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
    } catch {
      continue; // The process ended between the listing and the read.
    }
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    // After the command: state ppid pgrp … utime(11) stime(12) … rss(21), counting from 0 here.
    out.push({ pid: Number(name), ppid: num(f[1]), rss: num(f[21]) * page, cpuSeconds: (num(f[11]) + num(f[12])) / ticks });
  }
  return out;
}

/** What actually reached the block layer for one process — not the reads the page cache answered. */
function linuxIo(pid: number): { readBytes: number; writeBytes: number } | undefined {
  try {
    const io = fs.readFileSync(`/proc/${pid}/io`, 'utf8');
    return { readBytes: num(/^read_bytes:\s+(\d+)/m.exec(io)?.[1]), writeBytes: num(/^write_bytes:\s+(\d+)/m.exec(io)?.[1]) };
  } catch {
    return undefined; // Another user's process, or it ended between the listing and the read.
  }
}

/** `[[DD-]HH:]MM:SS[.ss]`, as `ps` prints accumulated CPU time. */
function cpuSecondsOf(time: string): number {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(time.trim());
  if (!m) return 0;
  return num(m[1]) * 86_400 + num(m[2]) * 3600 + num(m[3]) * 60 + num(m[4]);
}

/** macOS has no per-process disk counter without root, so `ps` gives the CPU time and the resident size only. */
function psProcesses(): Process[] {
  let out = '';
  try {
    out = execFileSync('ps', ['-Ao', 'pid=,ppid=,rss=,time='], { encoding: 'utf8', timeout: 5000, maxBuffer: 16 << 20 });
  } catch {
    return [];
  }
  const procs: Process[] = [];
  for (const line of out.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 4) continue;
    // `rss` is in kilobytes on every ps Sloth runs on.
    procs.push({ pid: num(f[0]), ppid: num(f[1]), rss: num(f[2]) * 1024, cpuSeconds: cpuSecondsOf(f[3]) });
  }
  return procs;
}

/** Windows: one CIM query has all five numbers. The two time fields are in 100ns ticks. */
function windowsProcesses(): Process[] {
  let out = '';
  try {
    out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Get-CimInstance Win32_Process | ForEach-Object { ($_.ProcessId, $_.ParentProcessId, $_.WorkingSetSize, $_.UserModeTime, $_.KernelModeTime, $_.ReadTransferCount, $_.WriteTransferCount) -join '|' }",
      ],
      { encoding: 'utf8', timeout: 10_000, windowsHide: true, maxBuffer: 16 << 20 },
    );
  } catch {
    return [];
  }
  const procs: Process[] = [];
  for (const line of out.split(/\r?\n/)) {
    const f = line.trim().split('|');
    if (f.length < 7) continue;
    procs.push({
      pid: num(f[0]),
      ppid: num(f[1]),
      rss: num(f[2]),
      cpuSeconds: (num(f[3]) + num(f[4])) / 1e7,
      readBytes: num(f[5]),
      writeBytes: num(f[6]),
    });
  }
  return procs;
}

const REAL: Readers =
  process.platform === 'linux'
    ? { processes: linuxProcesses, io: linuxIo }
    : { processes: process.platform === 'win32' ? windowsProcesses : psProcesses };
let readers = REAL;
/** Stand in a different table — the tests' way in; `undefined` puts the real readers back. */
export function setReaders(r?: Readers): void {
  readers = r ?? REAL;
}
/** The readers in force. Callers take `processes`, `io` and `now` from here, never from `REAL`. */
export const table = (): Readers => readers;
