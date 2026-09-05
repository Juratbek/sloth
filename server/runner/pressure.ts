import path from 'node:path';
import { cfg } from '../config';
import { snapshot } from './board-snapshot';
import { isDry, log, nowSec, readFile, readNumber, remove, write } from './log';
import { machineLoad } from './machine';
import { dirAlive, pidOf, runDirs, startedAt, stateOf, type RunDir } from './session-dirs';

/**
 * What happens when the machine stays over its limits with sessions already running: the holds in
 * `machine.ts` only keep new ones from starting, so a laptop pushed to the edge by the ones it has was
 * on its own. Now the lowest-priority run is paused — SIGSTOP to its process group and to the servers
 * it recorded, which stops their CPU and disk use on the spot and lets the OS page their memory out —
 * and resumed with SIGCONT once the machine has had room for a while. One run per reading, either way,
 * and only after the readings have said the same for `STEADY_SECONDS` — a minute, and two of them at
 * least — so a launch's install storm does not pause the session doing it. Readings are `machineSeconds`
 * apart and not a board poll apart, so this acts while the memory is going rather than minutes after
 * the kernel has already killed something; the trend is measured in time and not in readings, so a
 * shorter interval, or a tick's reading right behind the timer's, does not make it trigger-happy. Status replies
 * are not runs and are never paused. Windows has no SIGSTOP; there the holds are all Sloth can do.
 */

export interface PausedRun {
  since: number;
  reason: string;
}

/** How long the readings must agree before a run is paused or resumed — and never on one reading alone. */
export const STEADY_SECONDS = 60;

const file = (dir: string) => path.join(dir, 'paused');
const totalFile = (dir: string) => path.join(dir, 'paused_total');

export function pausedRun(dir: string): PausedRun | undefined {
  try {
    return JSON.parse(readFile(file(dir)) ?? '') as PausedRun;
  } catch {
    return undefined;
  }
}

/**
 * Seconds this run has spent paused so far — its budget clock does not tick while it is stopped. Up to
 * `until` when the ledger books a run that ended before the tick noticed, exactly as `waitedSeconds` is:
 * a run paused when Sloth went down was measured to *now* instead, so a three-hour outage subtracted
 * three hours from a run that had worked forty minutes, and the ledger booked it as zero.
 */
export function pausedSeconds(dir: string, until = nowSec()): number {
  const p = pausedRun(dir);
  return readNumber(totalFile(dir)) + (p ? Math.max(0, Math.min(until, nowSec()) - p.since) : 0);
}

/** The pids a run consists of: its own `claude`, and every server it recorded — each with its process group. */
function pidsOf(dir: string): number[] {
  const pids = [pidOf(dir) ?? 0];
  for (const name of ['dev.pid', 'redis.pid']) for (const line of (readFile(path.join(dir, name)) ?? '').split('\n')) pids.push(Number(line.trim()));
  return pids.filter((p) => p > 0);
}

export function signalRun(dir: string, signal: 'SIGSTOP' | 'SIGCONT'): void {
  // Windows has no SIGSTOP and no SIGCONT: `process.kill` there ignores the name and *terminates* the
  // process instead, so pausing a session would silently kill it. Nothing is signalled — `canPause` keeps
  // `pressure` from ever pausing there, and this is the guard for the `resumeRun` the stop paths call.
  if (!canPause()) {
    log(`${signal} is not available on ${process.platform} — the run is left running`);
    return;
  }
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
 * Lowest priority first. The card's column decides: work in the QA column (the sweep's tests) matters
 * most, work in Code Review (a review, or an implement run sent back to fix the findings) next, and
 * everything else — In Progress above all — sits under them. Within a column the card's priority on the
 * board: a card without one ranks under every card that has one, as in pickup. Among equals the run
 * started last, which has the least to lose.
 */
export function byPriority(runs: RunDir[]): RunDir[] {
  const items = snapshot()?.items ?? [];
  const col = cfg().statusField.columns;
  // A review's directory is named after its PR; the issue it is for is written beside it.
  const cardOf = (r: RunDir) => items.find((i) => i.number === (r.kind === 'issue' || r.kind === 'qa' ? r.target : readNumber(path.join(r.dir, 'issue'))));
  const column = (r: RunDir) => {
    if (r.kind === 'qa') return 2;
    // A scheduled smoke test works for no card: it is the first to make room and the last to get it back.
    if (r.kind === 'smoke') return -1;
    if (r.kind !== 'issue') return 1;
    const status = cardOf(r)?.status;
    return status && status === col.qa.name ? 2 : status === col.codeReview.name ? 1 : 0;
  };
  // A finite "none" — Infinity minus Infinity is NaN, which would leave the sort undefined.
  const priority = (r: RunDir) => cardOf(r)?.priority ?? 1e9;
  return [...runs].sort((a, b) => column(a) - column(b) || priority(b) - priority(a) || startedAt(b.dir) - startedAt(a.dir));
}

/** The readings in a row that said the same, and when the first of them was taken. */
interface Trend {
  readings: number;
  since: number;
}
const none = (): Trend => ({ readings: 0, since: 0 });
const extend = (t: Trend): Trend => ({ readings: t.readings + 1, since: t.readings ? t.since : nowSec() });
const steady = (t: Trend) => t.readings >= 2 && nowSec() - t.since >= STEADY_SECONDS;
let over = none();
let clear = none();
/** Tests start each case from a fresh trend. */
export function resetPressure(): void {
  over = none();
  clear = none();
}

const working = () => runDirs().filter((d) => dirAlive(d.dir) && (stateOf(d.dir).state ?? 'working') === 'working');

/** Every tick, after the machine was read: pause one run when it has been over its limits, resume one when it has had room. */
export function pressure(): void {
  const load = machineLoad();
  if (!load || !canPause()) return;
  const runs = working();
  const paused = runs.filter((d) => pausedRun(d.dir));
  if (load.hold) {
    clear = none();
    over = extend(over);
    const running = byPriority(runs.filter((d) => !pausedRun(d.dir)));
    if (!steady(over) || !running.length) return;
    over = none();
    const [victim] = running;
    if (isDry()) {
      log(`dry-run: would pause ${victim.name} (${load.hold})`);
      return;
    }
    pauseRun(victim.dir, load.hold);
    log(`paused ${victim.name} — ${load.hold}; it resumes when the machine has room (${paused.length + 1} paused)`);
    return;
  }
  over = none();
  clear = extend(clear);
  if (!steady(clear) || !paused.length) return;
  clear = none();
  const back = byPriority(paused).at(-1)!;
  if (isDry()) {
    log(`dry-run: would resume ${back.name}`);
    return;
  }
  resumeRun(back.dir);
  log(`resumed ${back.name} — the machine has room again (${paused.length - 1} still paused)`);
}
