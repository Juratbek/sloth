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
 * `.git` is somebody's and is left alone, with the reason on the health chip. The clone goes into a
 * sibling directory and is renamed into place when it is done: git writes `.git` before it has fetched
 * a single object, so `.git` at `runnerRoot` means a finished clone and never one in progress, and what
 * a killed or failed clone left behind is Sloth's own to delete before the next try. One clone runs at
 * a time — the boot, the tick and the Settings button share it — and a clone that failed is not tried
 * again for `RETRY_MS`, so a repository `gh` cannot reach does not cost every tick a ten-minute wait.
 */

export type CheckoutState = { kind: 'ready' } | { kind: 'missing' } | { kind: 'cloning'; repo: string } | { kind: 'error'; error: string };

/** Long enough for a repository the size of a real product; `gh` streams nothing back, so nothing shorter is safe. */
const CLONE_TIMEOUT = 600_000;
export const RETRY_MS = 10 * 60_000;

export interface CloneResult {
  ok: boolean;
  path?: string;
  error?: string;
}

const inFlight = new Map<string, { repo: string; done: Promise<CloneResult> }>();
const failed = new Map<string, { repo: string; error: string; at: number }>();
/** Clones go one after another: two at once double the time both take. */
let queue: Promise<unknown> = Promise.resolve();

const isGitCheckout = (dir: string): boolean => fs.existsSync(path.join(dir, '.git'));
/** Where a clone is made before it is renamed to `target` — beside it, so the rename never crosses a filesystem. */
const staging = (target: string): string => `${target}.cloning`;

/** Why `dir` cannot be cloned into: it is a file, it holds somebody's files, or it cannot be read at all. */
function blocker(dir: string): string | undefined {
  try {
    if (!fs.existsSync(dir)) return undefined;
    if (!fs.statSync(dir).isDirectory()) return `${dir} is a file, not a directory — point runnerRoot elsewhere`;
    if (fs.readdirSync(dir).length) return `${dir} exists but is not a git checkout — move it away, or point runnerRoot elsewhere`;
    return undefined;
  } catch (e) {
    return `${dir} could not be read — ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** What is at `target` right now — with what the last clone into it did, when it is not a checkout. */
export function checkoutState(target = cfg().runnerRoot): CheckoutState {
  const running = inFlight.get(target);
  if (running) return { kind: 'cloning', repo: running.repo };
  if (isGitCheckout(target)) return { kind: 'ready' };
  const blocked = blocker(target);
  if (blocked) return { kind: 'error', error: blocked };
  const last = failed.get(target);
  if (last) return { kind: 'error', error: last.error };
  return { kind: 'missing' };
}

const notFound = (err: string) => (/ENOENT/.test(err) ? '`gh` was not found on PATH' : err.split('\n').find((l) => l.trim())?.trim() || 'gh repo clone failed');

/**
 * Clones `repo` into `target` unless a checkout is already there. Two callers for the same clone share
 * it; a different repository into a target being cloned into is refused rather than raced.
 */
export function cloneRepo(repo: string, target: string): Promise<CloneResult> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return Promise.resolve({ ok: false, error: 'repo must be owner/repo' });
  const running = inFlight.get(target);
  if (running) return running.repo === repo ? running.done : Promise.resolve({ ok: false, error: `a clone of ${running.repo} into ${target} is still running` });
  if (isGitCheckout(target)) return Promise.resolve({ ok: true, path: target });
  const blocked = blocker(target);
  if (blocked) return Promise.resolve({ ok: false, error: blocked });
  const done = queue.then(() => clone(repo, target));
  queue = done.catch(() => undefined);
  inFlight.set(target, { repo, done });
  return done.finally(() => {
    if (inFlight.get(target)?.done === done) inFlight.delete(target);
  });
}

async function clone(repo: string, target: string): Promise<CloneResult> {
  if (isGitCheckout(target)) return { ok: true, path: target };
  if (isDry()) {
    log(`dry-run: would clone ${repo} into ${target}`);
    return { ok: false, error: `dry run — ${repo} was not cloned` };
  }
  log(`checkout: cloning ${repo} into ${target}`);
  const tmp = staging(target);
  let error: string;
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const r = await run('gh', ['repo', 'clone', repo, tmp], { timeout: CLONE_TIMEOUT, killTree: true });
    if (r.ok && isGitCheckout(tmp)) {
      // An empty directory left for the clone gives way to it; anything more was refused above.
      if (fs.existsSync(target)) fs.rmdirSync(target);
      fs.renameSync(tmp, target);
      failed.delete(target);
      log(`checkout: ${repo} cloned into ${target}`);
      return { ok: true, path: target };
    }
    error = r.ok ? `gh repo clone finished but left no checkout` : notFound(r.err);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  failed.set(target, { repo, error, at: Date.now() });
  log(`checkout: cloning ${repo} into ${target} failed — ${error}`);
  return { ok: false, error };
}

/** Whether the sessions have a checkout to fetch in — the launchers ask before leasing a slot. */
export const checkoutReady = (): boolean => checkoutState().kind === 'ready';

/**
 * The configured checkout, cloned if it is not there. `true` when the sessions can fetch in it. A clone
 * that failed is tried again after `RETRY_MS` — or at once when the repository or the root changed under
 * it, since the failure was the old pair's.
 */
export async function ensureCheckout(now = Date.now()): Promise<boolean> {
  const { repo, runnerRoot, configured } = cfg();
  if (!configured) return false;
  if (checkoutReady()) return true;
  const last = failed.get(runnerRoot);
  if (last && last.repo === repo && now - last.at < RETRY_MS) return false;
  return (await cloneRepo(repo, runnerRoot)).ok;
}

/** `ensureCheckout` for the callers that do not wait on it: the boot, a config save, a tick. Never rejects. */
export function checkoutInBackground(): Promise<boolean> {
  return ensureCheckout().catch((e) => {
    log(`checkout: ${(e instanceof Error ? e.message : String(e)).split('\n')[0]}`);
    return false;
  });
}

/** Tests only: forget the clones in flight and the last failures. */
export function forgetCheckout(): void {
  inFlight.clear();
  failed.clear();
  queue = Promise.resolve();
}
