import fs from 'node:fs';
import path from 'node:path';
import { cfg } from '../config';
import { run } from './gh';
import { log, readFile, remove, write } from './log';
import { statePath } from './markers';
import { dirAlive, dirOf, issueDir, parseRunName, type Kind } from './session-dirs';
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
 */

export const slotName = (n: number) => `slot-${n}`;
export const slotDir = (name: string) => path.join(cfg().worktreesDir, name);
const leaseFile = (name: string) => statePath('slots', name);
const runName = (kind: Kind, target: number) => `${kind}-${target}`;

/** Whether the run a lease names is still using its slot: alive, or done with its app kept up for a preview. */
function holds(lease: string): boolean {
  const run = parseRunName(lease);
  if (!run) return false;
  const { kind, target } = run;
  if (dirAlive(dirOf(kind, target))) return true;
  return kind === 'issue' && fs.existsSync(path.join(issueDir(target), 'preview-state.json'));
}

/** Whether a slot is held by a run that still needs it; a stale lease or none at all counts as free. */
export function slotInUse(name: string): boolean {
  const lease = readFile(leaseFile(name))?.trim();
  return !!lease && holds(lease);
}

/** The slot a run holds, if any. */
export function slotOf(kind: Kind, target: number): string | undefined {
  const me = runName(kind, target);
  for (let n = 1; n <= cfg().maxActive; n++) {
    if (readFile(leaseFile(slotName(n)))?.trim() === me) return slotName(n);
  }
  return undefined;
}

/**
 * Leases a slot to a run and makes sure its worktree exists, detached so no branch is pinned; the
 * session checks out what it needs. A run that already holds one keeps it. Undefined when every slot
 * is held by a live or previewing run — the caller queues the run like it does when the machine is busy.
 */
export async function leaseSlot(kind: Kind, target: number): Promise<string | undefined> {
  const c = cfg();
  const me = runName(kind, target);
  let free: string | undefined;
  let mine: string | undefined;
  for (let n = 1; n <= c.maxActive; n++) {
    const name = slotName(n);
    const lease = readFile(leaseFile(name))?.trim();
    if (lease === me) {
      free = name;
      mine = undefined;
      break;
    }
    if (lease && holds(lease)) continue;
    // The slot whose warm stack this very run left behind beats any other free one: leasing it back
    // is what turns a retry into a session that starts with everything already up (`warm.ts`).
    if (!mine && warmOf(name)?.run === me) mine = name;
    if (!free) free = name;
  }
  free = mine ?? free;
  if (!free) return undefined;
  const dir = slotDir(free);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(c.worktreesDir, { recursive: true });
    // A leftover registration of a slot whose directory went missing would block the add.
    await run('git', ['-C', c.runnerRoot, 'worktree', 'prune'], { timeout: 60_000 });
    const r = await run('git', ['-C', c.runnerRoot, 'worktree', 'add', '--detach', dir, 'HEAD'], { timeout: 120_000 });
    if (!r.ok) {
      log(`${free} could not be created: ${r.err.split('\n')[0]}`);
      return undefined;
    }
    log(`made ${free} at ${dir}`);
  }
  write(leaseFile(free), me);
  return free;
}

/**
 * Gives a run's slot back: the lease goes, and the worktree is detached so the branch the run was on can
 * be checked out again elsewhere. The files stay — they are the next run's head start.
 */
export async function releaseSlot(kind: Kind, target: number): Promise<void> {
  const name = slotOf(kind, target);
  if (!name) return;
  remove(leaseFile(name));
  const dir = slotDir(name);
  if (fs.existsSync(dir)) await run('git', ['-C', dir, 'checkout', '-q', '--detach'], { timeout: 60_000 });
}
