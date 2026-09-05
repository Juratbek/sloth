import fs from 'node:fs';
import path from 'node:path';
import { cfg } from './config';
import { run } from './runner/gh';
import { isDry, log } from './runner/log';

/**
 * The runner checkout — `runnerRoot`, the clone every session fetches in and every worktree slot is
 * made from — is Sloth's to make, not the user's. The wizard used to leave it to a button, and a config
 * saved without pressing it was a Sloth that failed every launch with "git fetch origin failed" in a
 * folder that was not there. Now the checkout is looked for at boot, after every config save and at the
 * top of every board tick, and cloned with `gh repo clone` the moment it is missing.
 *
 * "Missing" is a path that is not there or an empty directory; a directory with anything in it and no
 * `.git` is somebody's and is left alone, with the reason on the health chip. One clone runs at a time
 * — the boot, the tick and the Settings button share it — and a clone that failed is not tried again
 * for `RETRY_MS`, so a repository `gh` cannot reach does not cost every tick a five-minute wait.
 */

export type CheckoutState = { kind: 'ready' } | { kind: 'missing' } | { kind: 'cloning'; repo: string } | { kind: 'error'; error: string };

/** Long enough for a repository the size of a real product; `gh` streams nothing back, so nothing shorter is safe. */
const CLONE_TIMEOUT = 600_000;
export const RETRY_MS = 10 * 60_000;

let inFlight: { target: string; repo: string; done: Promise<CloneResult> } | undefined;
let failed: { target: string; error: string; at: number } | undefined;

export interface CloneResult {
  ok: boolean;
  path?: string;
  error?: string;
}

const isGitCheckout = (dir: string): boolean => fs.existsSync(path.join(dir, '.git'));
/** Somebody's files, not a checkout: a path that is there, is not empty and has no `.git`. */
const occupied = (dir: string): boolean => fs.existsSync(dir) && !(fs.statSync(dir).isDirectory() && fs.readdirSync(dir).length === 0);
const occupiedError = (dir: string) => `${dir} exists but is not a git checkout — move it away, or point runnerRoot elsewhere`;

/** What is at `target` right now — with what the last clone into it did, when it is not a checkout. */
export function checkoutState(target = cfg().runnerRoot): CheckoutState {
  if (isGitCheckout(target)) return { kind: 'ready' };
  if (inFlight?.target === target) return { kind: 'cloning', repo: inFlight.repo };
  if (occupied(target)) return { kind: 'error', error: occupiedError(target) };
  if (failed?.target === target) return { kind: 'error', error: failed.error };
  return { kind: 'missing' };
}

const notFound = (err: string) => (/ENOENT/.test(err) ? '`gh` was not found on PATH' : err.split('\n').find((l) => l.trim())?.trim() || 'gh repo clone failed');

/**
 * Clones `repo` into `target` unless a checkout is already there. Two callers for the same target share
 * one clone; a second target while one is running waits its turn, since two clones at once double the
 * time both take.
 */
export function cloneRepo(repo: string, target: string): Promise<CloneResult> {
  if (isGitCheckout(target)) return Promise.resolve({ ok: true, path: target });
  if (inFlight?.target === target) return inFlight.done;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return Promise.resolve({ ok: false, error: 'repo must be owner/repo' });
  if (occupied(target)) return Promise.resolve({ ok: false, error: occupiedError(target) });
  const previous = inFlight?.done ?? Promise.resolve();
  const done = previous.then(() => clone(repo, target));
  inFlight = { target, repo, done };
  return done.finally(() => {
    if (inFlight?.done === done) inFlight = undefined;
  });
}

async function clone(repo: string, target: string): Promise<CloneResult> {
  if (isGitCheckout(target)) return { ok: true, path: target };
  if (isDry()) {
    log(`dry-run: would clone ${repo} into ${target}`);
    return { ok: false, error: `dry run — ${repo} was not cloned` };
  }
  log(`checkout: cloning ${repo} into ${target}`);
  let error: string;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const r = await run('gh', ['repo', 'clone', repo, target], { timeout: CLONE_TIMEOUT });
    if (r.ok && isGitCheckout(target)) {
      failed = undefined;
      log(`checkout: ${repo} cloned into ${target}`);
      return { ok: true, path: target };
    }
    error = r.ok ? `gh repo clone finished but left no checkout at ${target}` : notFound(r.err);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  failed = { target, error, at: Date.now() };
  log(`checkout: cloning ${repo} into ${target} failed — ${error}`);
  return { ok: false, error };
}

/**
 * The configured checkout, cloned if it is not there. `true` when the sessions can fetch in it. Called
 * at boot, after a config save and by every board tick, so a clone that failed once is tried again on
 * its own — after `RETRY_MS`, or at once when the config changed under it.
 */
export async function ensureCheckout(now = Date.now()): Promise<boolean> {
  const { repo, runnerRoot, configured } = cfg();
  if (!configured) return false;
  if (isGitCheckout(runnerRoot)) return true;
  if (failed?.target === runnerRoot && now - failed.at < RETRY_MS) return false;
  return (await cloneRepo(repo, runnerRoot)).ok;
}

/** Tests only: forget the clone in flight and the last failure. */
export function forgetCheckout(): void {
  inFlight = undefined;
  failed = undefined;
}
