import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cfg } from '../config';
import type { WatcherState } from '../types';
import { readFile, readNumber } from './log';
import { statePath } from './markers';

/**
 * `approved` is trigger 4's `/sloth:review <pr> final`, the review a Code Review card gets; `qa` is trigger
 * 9's `/sloth:qa <issue>`, the QA sweep's test of one card — named after the issue, but apart from its
 * implement run, so the two never share a directory or a worktree. `smoke` is trigger 11's `/sloth:smoke <n>`,
 * the scheduled smoke test of the whole app — its number is the run's own, counted up in `state/smoke_seq`,
 * since it works for no card. `review` was the plain `/sloth:review` an older Sloth ran on human PRs: nothing
 * starts one any more, but its directories still list, count and prune like the rest.
 */
export type Kind = 'issue' | 'review' | 'approved' | 'qa' | 'smoke';
export const KINDS: Kind[] = ['issue', 'review', 'approved', 'qa', 'smoke'];

export interface RunDir {
  name: string;
  kind: Kind;
  target: number;
  dir: string;
}

/** `<sessionsDir>/issue-12` for the implement session of issue 12, `approved-34` for the review of PR 34. */
export const dirOf = (kind: Kind, target: number) => path.join(cfg().sessionsDir, `${kind}-${target}`);
export const issueDir = (issue: number) => dirOf('issue', issue);
export const approvedDir = (pr: number) => dirOf('approved', pr);
export const qaDir = (issue: number) => dirOf('qa', issue);
export const smokeDir = (n: number) => dirOf('smoke', n);
/** The per-run worktree of the old scheme — `issue-12`, `qa-12` — still removed when found; runs now lease a slot (`slots.ts`). */
export const worktreeName = (kind: Kind, target: number) => (kind === 'qa' || kind === 'smoke' ? `${kind}-${target}` : `issue-${target}`);

export function pidAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * When this machine last booted, in epoch seconds. A pid number only means anything within one boot:
 * after a restart the kernel hands the same numbers out again, and a pid file written before the boot
 * names whatever now holds that number — a browser, an editor, the user's own shell. `process.kill(pid, 0)`
 * happily says yes to it, so a dead run reads as alive for ever and is eventually killed by its budget,
 * taking a stranger's whole process group with it. `os.uptime()` answers this on every platform, which
 * `ps` does not.
 */
export const bootedAt = (): number => Math.floor(Date.now() / 1000 - os.uptime());

/** Whether `file` was written before the last boot, so the pids in it are somebody else's now (a missing file is not). */
export function predatesBoot(file: string): boolean {
  try {
    return Math.floor(fs.statSync(file).mtimeMs / 1000) < bootedAt();
  } catch {
    return false;
  }
}

export const pidOf = (dir: string) => readNumber(path.join(dir, 'pid')) || undefined;
export const dirAlive = (dir: string) => pidAlive(pidOf(dir)) && !predatesBoot(path.join(dir, 'pid'));
export const issueAlive = (issue: number) => dirAlive(issueDir(issue));

/**
 * A run's name back into the kind and target it was made from — `dirOf` read backwards. One reader, so a
 * kind added to `KINDS` is a kind every caller sees: a directory listing, a worktree lease, the monitor.
 * Anything else (a stray file, a directory a human made) is not a run.
 */
export function parseRunName(name: string): { kind: Kind; target: number } | undefined {
  const m = /^(issue|review|approved|qa|smoke)-(\d+)$/.exec(name);
  return m ? { kind: m[1] as Kind, target: Number(m[2]) } : undefined;
}

/** Every session directory Sloth has ever created, live or not. */
export function runDirs(): RunDir[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(cfg().sessionsDir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const run = parseRunName(name);
    return run ? [{ name, ...run, dir: path.join(cfg().sessionsDir, name) }] : [];
  });
}

/**
 * What a session writes into its `state.json` (the contract is in `plugin/README.md`). One shape, shared
 * with the monitor: `WatcherState` in `types.ts` is what the UI reads off the very same file, and two
 * copies of it drifted apart the moment either end learned a new field.
 */
export type RunState = WatcherState;

/** The run's `state.json`, or undefined when it has none yet — or one no parser will take. */
export function readState(dir: string): RunState | undefined {
  try {
    return JSON.parse(readFile(path.join(dir, 'state.json')) ?? '') as RunState;
  } catch {
    return undefined;
  }
}

/** The same, as the runner wants it: a run that has said nothing is a run with nothing to say. */
export const stateOf = (dir: string): RunState => readState(dir) ?? {};

/**
 * When the run itself was launched — `started`, written by `start` and by nothing else. This is what the
 * time budget is measured from. The session's own `since` cannot be: the plugin's `set_state` helper
 * defaults it to now on every call, so a session that changes step every few minutes pushes its own
 * deadline back for ever and is never killed, which is the opposite of what a budget is for. A run
 * launched by an older Sloth has no `started`, and the pid file's mtime dates it well enough.
 */
export function launchedAt(dir: string): number {
  // The server's own copy of the mark, outside the session's directory (`spawn.ts`), wins over the one
  // beside the run when it is the same run's — the pid says so. A session could rewrite the one it can
  // reach and bill ten hours it never worked; it cannot reach this one.
  const own = (readFile(statePath('started', path.basename(dir))) ?? '').trim().split(' ');
  if (own.length === 2 && own[0] === String(pidOf(dir) ?? '') && Number(own[1]) > 0) return Number(own[1]);
  const started = readNumber(path.join(dir, 'started'));
  if (started) return started;
  try {
    return Math.floor(fs.statSync(path.join(dir, 'pid')).mtimeMs / 1000);
  } catch {
    return Math.floor(Date.now() / 1000);
  }
}

/** When the current phase of the run started — the session's own mark, else when it was launched. */
export function startedAt(dir: string): number {
  return stateOf(dir).since || launchedAt(dir);
}

export const counter = (dir: string, name: string) => readNumber(path.join(dir, name));
/** How many runs this directory has had on `sha`; 0 when its last one was on another head, since a new head is a new count. */
export const triesOn = (dir: string, sha: string) => ((readFile(path.join(dir, 'sha')) ?? '').trim() === sha ? counter(dir, 'retries') : 0);
export const isBlocked = (dir: string) => fs.existsSync(path.join(dir, 'blocked'));

/**
 * Where a status reply (`/sloth:status`, trigger 3) books its pid and session id. It is not a run
 * directory: the reply reads the issue's own directory and must not overwrite the pid of the run that
 * wrote it, so it keeps its books under `state/status/` instead — which is why it used to be invisible
 * to everything below. It still starts a `claude` process, so it still takes a slot.
 */
export const statusDir = (issue: number, commentId: string) => path.join(cfg().stateDir, 'status', `${issue}-${commentId}`);

/** The book directories of every status reply, live or not. */
export function statusDirs(): string[] {
  const root = path.join(cfg().stateDir, 'status');
  try {
    return fs.readdirSync(root).map((name) => path.join(root, name));
  } catch {
    return [];
  }
}

/**
 * Every live run, whatever kind: the sessions and the status replies both. A status reply needs no
 * reaping of its own — it leases no slot, boots no app and moves no card, so there is nothing to tear
 * down once it is gone — but while it lives it is a `claude` process like any other and is counted like
 * one. A reply writes no `state.json` of its own (it borrows the issue's directory read-only), so it
 * reads as `working` and counts against `maxActive` too.
 */
const live = () => [...runDirs().map((d) => d.dir), ...statusDirs()].filter(dirAlive);
export const countAlive = () => live().length;
export const countActive = () => live().filter((dir) => (stateOf(dir).state ?? 'working') === 'working').length;

/** No slot left: either every session, or every working session, is spoken for. */
export const slotsFull = () => countAlive() >= cfg().maxAlive || countActive() >= cfg().maxActive;
