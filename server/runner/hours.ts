import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { cfg } from '../config';
import { billable, type HoursEnding, type HoursEntry, type HoursKind } from '../hours-types';
import { isDry, log, nowSec, readFile, readNumber, write } from './log';
import { statePath } from './markers';
import { pausedSeconds } from './pressure';
import { launchedAt, stateOf } from './session-dirs';
import { waitedSeconds } from './waiting';

/**
 * The hours ledger: one line per run that ended, appended by the server when it notices the end (`reap`
 * and `stop` in `run-control.ts`) and by nothing else. It is what a project is billed by, so it has to
 * outlive the run's own files — a session directory and its transcript go after `keepDays` — and it has
 * to show when it has been touched: the session that mentions a comment ordered "clear the hours" runs
 * on this machine with every permission, and could edit any file. Nothing keeps it from writing here;
 * what the ledger does is make the edit visible. Every line carries a fingerprint of its own text and
 * the fingerprint of the line before it, so a line removed, changed or inserted breaks the chain from
 * that point on, and `readLedger` says so. The branch copy (`hours-copy.ts`) is the second witness.
 *
 * Sessions are never told the file exists: it is not in their environment, not in the plugin, not in the
 * skill that reads their session directory.
 */

/** Extra time past its budget before `reap` kills a session — the most any unmarked end can lie beyond the budget. */
export const KILL_GRACE = 5 * 60;

export const ledgerFile = () => statePath('hours.jsonl');
/** Set when the ledger has lines the branch copy has not; `hours-copy.ts` clears it after the push. */
export const unpublishedFile = () => statePath('hours_unpublished');

const fingerprint = (text: string) => createHash('sha256').update(text).digest('hex');

/** The text a line's `hash` is over: the entry with every field but the hash, in the order it was written. */
const bodyOf = (e: HoursEntry): string => {
  const { hash: _hash, ...rest } = e;
  return JSON.stringify(rest);
};

export interface Ledger {
  /** Every entry up to the first bad line — the ones that can still be trusted. */
  entries: HoursEntry[];
  /** Where the chain broke, in one line; absent when every line checks out. */
  problem?: string;
}

/** The whole ledger, verified line by line. */
export function readLedger(): Ledger {
  const text = readFile(ledgerFile());
  if (!text) return { entries: [] };
  const entries: HoursEntry[] = [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  let prev = '';
  for (const [i, line] of lines.entries()) {
    const at = i + 1;
    let e: HoursEntry;
    try {
      e = JSON.parse(line) as HoursEntry;
    } catch {
      return { entries, problem: `line ${at} is not a ledger entry` };
    }
    if (typeof e !== 'object' || e === null || typeof e.hash !== 'string') return { entries, problem: `line ${at} is not a ledger entry` };
    if (e.n !== at) return { entries, problem: `line ${at} is numbered ${e.n} — ${e.n > at ? `${e.n - at} line(s) before it were removed` : 'a line was inserted before it'}` };
    if (e.prev !== prev) return { entries, problem: `line ${at} does not follow line ${at - 1} — the line before it was changed or removed` };
    if (fingerprint(bodyOf(e)) !== e.hash) return { entries, problem: `line ${at} was changed after it was written` };
    entries.push(e);
    prev = e.hash;
  }
  return { entries };
}

/** The newest line as it stands, verified or not: what the next line chains onto. */
function lastLine(): { n: number; hash: string } {
  const text = (readFile(ledgerFile()) ?? '').trimEnd();
  const line = text.slice(text.lastIndexOf('\n') + 1);
  if (!line) return { n: 0, hash: '' };
  try {
    const e = JSON.parse(line) as Partial<HoursEntry>;
    return { n: Number(e.n) || 0, hash: typeof e.hash === 'string' ? e.hash : '' };
  } catch {
    return { n: 0, hash: '' };
  }
}

/**
 * Seconds a run has been its own so far — launched, minus the time it stood paused for the machine and the
 * time it sat in needs-help waiting for an answer. A parked session keeps its process alive while it
 * waits, so its span from launch to end holds the wait; nobody worked those hours, and the budget clock
 * (`run-control.ts`) does not count them either.
 */
export const runSeconds = (dir: string, until = nowSec()): number => Math.max(0, until - launchedAt(dir) - pausedSeconds(dir) - waitedSeconds(dir));

/** The issue a run in `dir` works for: an implement or QA run is named after it, a review has it written beside it. */
export const issueOfRun = (kind: HoursKind, target: number, dir: string): number | undefined =>
  kind === 'issue' || kind === 'qa' ? target : readNumber(path.join(dir, 'issue')) || undefined;

/** The last time the run wrote to its own log — it was alive at least until then, and not much after. */
function lastWrote(dir: string): number {
  try {
    return Math.floor(fs.statSync(path.join(dir, 'run.log')).mtimeMs / 1000);
  } catch {
    return 0;
  }
}

/**
 * When a run ended. The tick that notices an end may be five minutes behind it — a whole outage, even —
 * and every one of those minutes would be billed, so the earliest honest mark wins. A run that marked
 * itself `done` (or gave up asking) or `waiting` ended when it said so: `since` in its state. One that
 * ended without a word has the moment its process exited, written by the server that spawned it
 * (`exited`), and the last time it wrote to its log. A run Sloth killed ended now, by definition. A mark
 * outside the run's life — before the launch, in the future — is not trusted. With no mark at all (the
 * server was down, the log is gone) the end is now, but never later than the run could have lived: past
 * its budget and the kill grace `reap` would have stopped it, so nothing beyond that is its own.
 */
function endedAt(dir: string, kind: HoursKind, ending: HoursEnding, startedAt: number, now: number): number {
  if (ending === 'stopped' || ending === 'budget') return now;
  const said = ending === 'done' || ending === 'noResponse' || ending === 'waiting' ? Number(stateOf(dir).since) || 0 : 0;
  const marks = [said, readNumber(path.join(dir, 'exited')), lastWrote(dir)].filter((t) => t >= startedAt && t <= now);
  if (marks.length) return Math.min(...marks);
  const budget = (kind === 'qa' ? cfg().qa.budgetMinutes : cfg().budgetMinutes) * 60;
  return Math.min(now, startedAt + budget + KILL_GRACE);
}

/**
 * Books a run that has just ended. Called before the run's `pid`, pause and waiting files go — `launchedAt`
 * falls back to the pid file's date for a run launched by an older Sloth, and the paused and waited seconds
 * live beside it.
 * A dry tick books nothing: it forgets no pid either, so the real tick after it books the run once.
 */
export function bookRun(kind: HoursKind, target: number, dir: string, ending: HoursEnding): HoursEntry | undefined {
  const name = `${kind}-${target}`;
  if (isDry()) {
    log(`dry-run: would book ${name} in the hours ledger (${ending})`);
    return undefined;
  }
  const startedAt = launchedAt(dir);
  const ended = endedAt(dir, kind, ending, startedAt, nowSec());
  const paused = pausedSeconds(dir);
  const waited = waitedSeconds(dir, ended);
  const last = lastLine();
  const entry: HoursEntry = {
    n: last.n + 1,
    kind,
    target,
    issue: issueOfRun(kind, target, dir),
    sessionId: readFile(path.join(dir, 'session_id'))?.trim() || undefined,
    startedAt,
    endedAt: ended,
    pausedSeconds: paused,
    waitedSeconds: waited,
    seconds: Math.max(0, ended - startedAt - paused - waited),
    ending,
    billable: billable(ending),
    ...(fs.existsSync(path.join(dir, 'started_fresh')) ? { fresh: true } : {}),
    prev: last.hash,
    hash: '',
  };
  entry.hash = fingerprint(bodyOf(entry));
  fs.mkdirSync(path.dirname(ledgerFile()), { recursive: true });
  fs.appendFileSync(ledgerFile(), `${JSON.stringify(entry)}\n`);
  write(unpublishedFile(), String(entry.n));
  const h = Math.floor(entry.seconds / 3600);
  const m = Math.floor((entry.seconds % 3600) / 60);
  log(`booked ${name}: ${h ? `${h}h ${m}m` : `${m}m`} — ${entry.billable ? `billable (${ending})` : `not billable (${ending})`}`);
  return entry;
}
