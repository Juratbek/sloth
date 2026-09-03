import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { billable, type HoursEnding, type HoursEntry, type HoursKind } from '../hours-types';
import { isDry, log, nowSec, readFile, readNumber, write } from './log';
import { statePath } from './markers';
import { pausedSeconds } from './pressure';
import { launchedAt } from './session-dirs';

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

/** Seconds a run has been its own so far — launched, minus the time it stood paused for the machine. */
export const runSeconds = (dir: string, until = nowSec()): number => Math.max(0, until - launchedAt(dir) - pausedSeconds(dir));

/** The issue a run in `dir` works for: an implement or QA run is named after it, a review has it written beside it. */
export const issueOfRun = (kind: HoursKind, target: number, dir: string): number | undefined =>
  kind === 'issue' || kind === 'qa' ? target : readNumber(path.join(dir, 'issue')) || undefined;

/**
 * Books a run that has just ended. Called before the run's `pid` and pause files go — `launchedAt` falls
 * back to the pid file's date for a run launched by an older Sloth, and the paused seconds live beside it.
 * A dry tick books nothing: it forgets no pid either, so the real tick after it books the run once.
 */
export function bookRun(kind: HoursKind, target: number, dir: string, ending: HoursEnding): HoursEntry | undefined {
  const name = `${kind}-${target}`;
  if (isDry()) {
    log(`dry-run: would book ${name} in the hours ledger (${ending})`);
    return undefined;
  }
  const endedAt = nowSec();
  const startedAt = launchedAt(dir);
  const paused = pausedSeconds(dir);
  const last = lastLine();
  const entry: HoursEntry = {
    n: last.n + 1,
    kind,
    target,
    issue: issueOfRun(kind, target, dir),
    sessionId: readFile(path.join(dir, 'session_id'))?.trim() || undefined,
    startedAt,
    endedAt,
    pausedSeconds: paused,
    seconds: Math.max(0, endedAt - startedAt - paused),
    ending,
    billable: billable(ending),
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
