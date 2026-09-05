import fs from 'node:fs';
import path from 'node:path';
import { cfg } from './config';
import { repos } from './repos';
import type { RepoConfig } from './repo-types';
import { run } from './runner/gh';
import { isDry, log } from './runner/log';

/**
 * A repository's checkout — its `root`, the clone every session of it fetches in and every worktree slot
 * of it is made from — is Sloth's to make, not the user's. The wizard used to leave it to a button, and a
 * config saved without pressing it was a Sloth that failed every launch with "git fetch origin failed" in
 * a folder that was not there. Now every repository's checkout is looked for at boot, after every config
 * save and at the top of every board tick, and cloned with `gh repo clone` the moment it is missing.
 *
 * "Missing" is a path that is not there or an empty directory; a directory with anything in it and no
 * `.git` is somebody's and is left alone, with the reason on the health chip. One clone runs at a time
 * — the boot, the tick and the Settings button share it, and a second repository waits for the first —
 * and a clone that failed is not tried again for `RETRY_MS`, so a repository `gh` cannot reach does not
 * cost every tick a five-minute wait.
 */

export type CheckoutState = { kind: 'ready' } | { kind: 'missing' } | { kind: 'cloning'; repo: string } | { kind: 'error'; error: string };

/** Long enough for a repository the size of a real product; `gh` streams nothing back, so nothing shorter is safe. */
const CLONE_TIMEOUT = 600_000;
export const RETRY_MS = 10 * 60_000;

let inFlight: { target: string; repo: string; done: Promise<CloneResult> } | undefined;
/** The last clone that failed, by the path it was going into. */
const failed = new Map<string, { error: string; at: number }>();

export interface CloneResult {
  ok: boolean;
  path?: string;
  error?: string;
}

const isGitCheckout = (dir: string): boolean => fs.existsSync(path.join(dir, '.git'));
/** Somebody's files, not a checkout: a path that is there, is not empty and has no `.git`. */
const occupied = (dir: string): boolean => fs.existsSync(dir) && !(fs.statSync(dir).isDirectory() && fs.readdirSync(dir).length === 0);
const occupiedError = (dir: string) => `${dir} exists but is not a git checkout — move it away, or point the repository's root elsewhere`;

/** What is at `target` right now — with what the last clone into it did, when it is not a checkout. */
export function checkoutState(target: string): CheckoutState {
  if (isGitCheckout(target)) return { kind: 'ready' };
  if (inFlight?.target === target) return { kind: 'cloning', repo: inFlight.repo };
  if (occupied(target)) return { kind: 'error', error: occupiedError(target) };
  const last = failed.get(target);
  if (last) return { kind: 'error', error: last.error };
  return { kind: 'missing' };
}

const notFound = (err: string) => (/ENOENT/.test(err) ? '`gh` was not found on PATH' : err.split('\n').find((l) => l.trim())?.trim() || 'gh repo clone failed');

/**
 * Clones `repo` into `target` unless a checkout is already there. Two callers for the same target share
 * one clone; a second target while one is running waits its turn, since two clones at once double the
 * time both take.
 */
export function cloneRepo(repo: string, target: string, now = Date.now()): Promise<CloneResult> {
  if (isGitCheckout(target)) return Promise.resolve({ ok: true, path: target });
  if (inFlight?.target === target) return inFlight.done;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return Promise.resolve({ ok: false, error: 'repo must be owner/repo' });
  if (occupied(target)) return Promise.resolve({ ok: false, error: occupiedError(target) });
  const previous = inFlight?.done ?? Promise.resolve();
  const done = previous.then(() => clone(repo, target, now));
  const mine = { target, repo, done };
  inFlight = mine;
  return done.finally(() => {
    if (inFlight === mine) inFlight = undefined;
  });
}

/** `now` is the caller's clock — the retry window is measured from it, so a tick's own reading decides when the next try is due. */
async function clone(repo: string, target: string, now: number): Promise<CloneResult> {
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
      failed.delete(target);
      log(`checkout: ${repo} cloned into ${target}`);
      return { ok: true, path: target };
    }
    error = r.ok ? `gh repo clone finished but left no checkout at ${target}` : notFound(r.err);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  failed.set(target, { error, at: now });
  log(`checkout: cloning ${repo} into ${target} failed — ${error}`);
  return { ok: false, error };
}

/** One repository's checkout, cloned if it is not there; `true` when its sessions can fetch in it. */
async function ensureOne(r: RepoConfig, now: number): Promise<boolean> {
  if (isGitCheckout(r.root)) return true;
  const last = failed.get(r.root);
  if (last && now - last.at < RETRY_MS) return false;
  return (await cloneRepo(r.slug, r.root, now)).ok;
}

/**
 * Every configured checkout, cloned if it is not there, one after the other. `true` when every one of
 * them is a checkout the sessions can fetch in. Called at boot, after a config save and by every board
 * tick, so a clone that failed once is tried again on its own — after `RETRY_MS`, or at once when the
 * config changed under it. A repository whose clone failed does not hold the others back: each is tried.
 */
export async function ensureCheckout(now = Date.now()): Promise<boolean> {
  if (!cfg().configured) return false;
  let all = true;
  for (const r of repos()) if (!(await ensureOne(r, now))) all = false;
  return all;
}

/** The repositories whose checkout is there — the ones whose sessions can start. */
export const readyRepos = (): string[] => repos().filter((r) => isGitCheckout(r.root)).map((r) => r.slug);

/** Tests only: forget the clone in flight and the last failures. */
export function forgetCheckout(): void {
  inFlight = undefined;
  failed.clear();
}
