import path from 'node:path';
import { snapshot } from './board-snapshot';
import { isDry, log, nowSec, readFile, readNumber, remove, write } from './log';
import { machineLoad } from './machine';
import { dirAlive, pidOf, runDirs, startedAt, stateOf, type RunDir } from './session-dirs';

/**
 * What happens when the machine stays over its limits with sessions already running: the holds in
 * `machine.ts` only keep new ones from starting, so a laptop pushed to the edge by the ones it has was
 * on its own. Now the lowest-priority run is paused — SIGSTOP to its process group and to the servers
 * it recorded, which stops their CPU and disk use on the spot and lets the OS page their memory out —
 * and resumed with SIGCONT once the machine has had room for a while. One run per tick, either way,
 * and only after two readings in a row say the same, so a launch's install storm does not pause the
 * session doing it. Reviews and status replies are never paused: short, read-only, and first in line.
 * Windows has no SIGSTOP; there the holds are all Sloth can do.
 */

export interface PausedRun {
  since: number;
  reason: string;
}

/** How many readings in a row must agree before a run is paused or resumed. */
export const STEADY = 2;

const file = (dir: string) => path.join(dir, 'paused');
const totalFile = (dir: string) => path.join(dir, 'paused_total');

export function pausedRun(dir: string): PausedRun | undefined {
  try {
    return JSON.parse(readFile(file(dir)) ?? '') as PausedRun;
  } catch {
    return undefined;
  }
}

/** Seconds this run has spent paused so far — its budget clock does not tick while it is stopped. */
export function pausedSeconds(dir: string): number {
  const p = pausedRun(dir);
  return readNumber(totalFile(dir)) + (p ? Math.max(0, nowSec() - p.since) : 0);
}

/** The pids a run consists of: its own `claude`, and every server it recorded — each with its process group. */
function pidsOf(dir: string): number[] {
  const pids = [pidOf(dir) ?? 0];
  for (const name of ['dev.pid', 'redis.pid']) for (const line of (readFile(path.join(dir, name)) ?? '').split('\n')) pids.push(Number(line.trim()));
  return pids.filter((p) => p > 0);
}

export function signalRun(dir: string, signal: 'SIGSTOP' | 'SIGCONT'): void {
  for (const pid of pidsOf(dir)) {
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, signal);
      } catch {
        /* no such group, or already gone */
      }
    }
  }
}

export const canPause = () => process.platform !== 'win32';

export function pauseRun(dir: string, reason: string): void {
  if (pausedRun(dir)) return;
  write(file(dir), JSON.stringify({ since: nowSec(), reason }));
  signalRun(dir, 'SIGSTOP');
}

/** Wakes a paused run; also what `stop` and `cleanup` do first, since a stopped process cannot act on SIGTERM. */
export function resumeRun(dir: string): boolean {
  const p = pausedRun(dir);
  if (!p) return false;
  write(totalFile(dir), String(readNumber(totalFile(dir)) + Math.max(0, nowSec() - p.since)));
  remove(file(dir));
  signalRun(dir, 'SIGCONT');
  return true;
}

/** Forgets a run's pause bookkeeping — a new run on the issue starts with a full clock. */
export function forgetPause(dir: string): void {
  remove(file(dir));
  remove(totalFile(dir));
}

/**
 * Lowest priority first: the QA sweep's tests before implement runs (background work on merged fixes),
 * then the card's own priority on the board — a card without one ranks under every card that has one,
 * as in pickup — and among equals the run started last, which has the least to lose.
 */
export function byPriority(runs: RunDir[]): RunDir[] {
  const items = snapshot()?.items ?? [];
  // A finite "none" — Infinity minus Infinity is NaN, which would leave the sort undefined.
  const priority = (r: RunDir) => (r.kind === 'issue' ? (items.find((i) => i.number === r.target)?.priority ?? 1e9) : -1);
  const kind = (r: RunDir) => (r.kind === 'qa' ? 0 : 1);
  return [...runs].sort((a, b) => kind(a) - kind(b) || priority(b) - priority(a) || startedAt(b.dir) - startedAt(a.dir));
}

let overTicks = 0;
let clearTicks = 0;
/** Tests start each case from a fresh count. */
export function resetPressure(): void {
  overTicks = 0;
  clearTicks = 0;
}

const working = () => runDirs().filter((d) => (d.kind === 'issue' || d.kind === 'qa') && dirAlive(d.dir) && (stateOf(d.dir).state ?? 'working') === 'working');

/** Every tick, after the machine was read: pause one run when it has been over its limits, resume one when it has had room. */
export function pressure(): void {
  const load = machineLoad();
  if (!load || !canPause()) return;
  const runs = working();
  const paused = runs.filter((d) => pausedRun(d.dir));
  if (load.hold) {
    clearTicks = 0;
    const running = byPriority(runs.filter((d) => !pausedRun(d.dir)));
    if (++overTicks < STEADY || !running.length) return;
    overTicks = 0;
    const [victim] = running;
    if (isDry()) {
      log(`dry-run: would pause ${victim.name} (${load.hold})`);
      return;
    }
    pauseRun(victim.dir, load.hold);
    log(`paused ${victim.name} — ${load.hold}; it resumes when the machine has room (${paused.length + 1} paused)`);
    return;
  }
  overTicks = 0;
  if (++clearTicks < STEADY || !paused.length) return;
  clearTicks = 0;
  const back = byPriority(paused).at(-1)!;
  if (isDry()) {
    log(`dry-run: would resume ${back.name}`);
    return;
  }
  resumeRun(back.dir);
  log(`resumed ${back.name} — the machine has room again (${paused.length - 1} still paused)`);
}
