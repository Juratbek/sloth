import fs from 'node:fs';
import path from 'node:path';
import { cfg } from '../config';
import { isConfigured, repoRoot, tag, untagName } from '../repos';
import { run } from './gh';
import { log, readFile, remove, write } from './log';
import { statePath } from './markers';
import { dirAlive, dirOf, issueDir, parseRunName, runName, type RunRef } from './session-dirs';
import { warmOf } from './warm';

/**
 * The pool of worktrees the runs work in. A checkout is cheap; what is not is the install a fresh one
 * needs — a `node_modules` of several gigabytes, written again for every issue and thrown away with it.
 * So the worktrees are kept: `slot-1 … slot-<maxActive>` under `worktreesDir`, made once and reused. A
 * run leases one before it starts (`state/slots/slot-<n>` names the run), resets it to the branch it
 * needs — its dependencies survive the reset — and gives it back at teardown. The lease outlives the
 * run only while its app is up behind a preview. A lease whose run is gone is stale and taken over, so
 * a crash never loses a slot for good. Runs that started under the old scheme still have their own
 * `issue-<n>` / `qa-<n>` worktrees; `cleanup` and the sweep remove those as before.
 *
 * A slot is one number, and holds one worktree per repository: `slot-1` is the legacy repository's,
 * `slot-1@acme~api` the worktree of `acme/api` in the same slot (`repos.ts` `tag`). A run gets the one of
 * its own repository, and a session that has to change a second repository makes that one's beside it
 * (the `session` skill says how); the lease covers them all, and the release detaches them all.
 */

export const slotName = (n: number) => `slot-${n}`;
/** The worktree of `repo` in a slot. */
export const slotWorktree = (slot: string, repo: string) => path.join(cfg().worktreesDir, tag(slot, repo));
const leaseFile = (slot: string) => statePath('slots', slot);

/** Whether the run a lease names is still using its slot: alive, or done with its app kept up for a preview. */
function holds(lease: string): boolean {
  const run = parseRunName(lease);
  if (!run) return false;
  if (dirAlive(dirOf(run))) return true;
  return run.kind === 'issue' && fs.existsSync(path.join(issueDir({ repo: run.repo, number: run.target }), 'preview-state.json'));
}

/** Whether a slot is held by a run that still needs it; a stale lease or none at all counts as free. */
export function slotInUse(slot: string): boolean {
  const lease = readFile(leaseFile(slot))?.trim();
  return !!lease && holds(lease);
}

/** The slot a run holds, if any. */
export function slotOf(r: RunRef): string | undefined {
  const me = runName(r);
  for (let n = 1; n <= cfg().maxActive; n++) {
    if (readFile(leaseFile(slotName(n)))?.trim() === me) return slotName(n);
  }
  return undefined;
}

/** The worktrees a slot holds, one per repository — the slot's own directory and every `slot-n@…` beside it. */
export function slotWorktrees(slot: string): { repo: string; dir: string }[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(cfg().worktreesDir);
  } catch {
    return [];
  }
  return names.filter((name) => untagName(name).base === slot).map((name) => ({ repo: untagName(name).repo, dir: path.join(cfg().worktreesDir, name) }));
}

/**
 * Which free slot a run takes: the one whose warm stack this very run left behind — leasing it back turns a
 * retry into a session that starts with everything already up (`warm.ts`) — then one warming a stack of the
 * same repository, then one warming nothing, then the first free. A stack of another repository's app is
 * killed when its slot is taken, so it is the last choice.
 */
function preferred(free: string[], r: RunRef): string | undefined {
  const me = runName(r);
  const warmth = (slot: string) => {
    const w = warmOf(slot);
    return !w ? 1 : w.run === me ? 3 : w.repo === r.repo ? 2 : 0;
  };
  return [...free].sort((a, b) => warmth(b) - warmth(a))[0];
}

/**
 * Leases a slot to a run and makes sure the worktree of its repository exists, detached so no branch is
 * pinned; the session checks out what it needs. A run that already holds one keeps it. Undefined when every
 * slot is held by a live or previewing run — the caller queues the run like it does when the machine is busy.
 */
export async function leaseSlot(r: RunRef): Promise<string | undefined> {
  const c = cfg();
  const me = runName(r);
  const free: string[] = [];
  let mine: string | undefined;
  for (let n = 1; n <= c.maxActive; n++) {
    const slot = slotName(n);
    const lease = readFile(leaseFile(slot))?.trim();
    if (lease === me) {
      mine = slot;
      break;
    }
    if (!(lease && holds(lease))) free.push(slot);
  }
  const slot = mine ?? preferred(free, r);
  if (!slot) return undefined;
  if (!(await ensureWorktree(slot, r.repo))) return undefined;
  write(leaseFile(slot), me);
  return slot;
}

/** The worktree of `repo` in `slot`, made from the repository's checkout when it is not there yet. */
export async function ensureWorktree(slot: string, repo: string): Promise<boolean> {
  const dir = slotWorktree(slot, repo);
  if (fs.existsSync(dir)) return true;
  fs.mkdirSync(cfg().worktreesDir, { recursive: true });
  const root = repoRoot(repo);
  // A leftover registration of a slot whose directory went missing would block the add.
  await run('git', ['-C', root, 'worktree', 'prune'], { timeout: 60_000 });
  const r = await run('git', ['-C', root, 'worktree', 'add', '--detach', dir, 'HEAD'], { timeout: 120_000 });
  if (!r.ok) {
    log(`${path.basename(dir)} could not be created: ${r.err.split('\n')[0]}`);
    return false;
  }
  log(`made ${path.basename(dir)} at ${dir}`);
  return true;
}

/**
 * Gives a run's slot back: the lease goes, and every worktree of the slot is detached so the branches the
 * run was on can be checked out again elsewhere. The files stay — they are the next run's head start.
 */
export async function releaseSlot(r: RunRef): Promise<void> {
  const slot = slotOf(r);
  if (!slot) return;
  remove(leaseFile(slot));
  for (const { dir } of slotWorktrees(slot)) await run('git', ['-C', dir, 'checkout', '-q', '--detach'], { timeout: 60_000 });
}

/** Whether a worktree directory name is a slot's, and of a repository still configured — the sweep removes the rest. */
export const slotRepoConfigured = (name: string): boolean => isConfigured(untagName(name).repo);
