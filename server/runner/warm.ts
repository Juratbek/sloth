import { legacyRepo } from '../repos';
import { run } from './gh';
import { killTree } from './kill';
import { log, nowSec, readFile, remove, write } from './log';
import { statePath } from './markers';
import { dirOf, pidAlive, runName, type RunRef } from './session-dirs';
import { slotWorktree } from './slots';
import path from 'node:path';
import { cfg } from '../config';

/**
 * Warm slots. Booting a project's stack — a database created and pushed, Redis, a full build, the dev
 * servers — costs a session ten minutes before it can look at its issue, and the stack it builds is
 * issue-agnostic: the same watch-mode servers serve whatever the worktree holds. So when a run ends and
 * its slot stays in the pool, the servers are not killed and the database is not dropped. The pids and
 * the database name move from the session's directory into `state/slots/slot-<n>.warm`, and the next
 * run that leases the slot gets them back under the same file convention, told through `SLOTH_WARM`
 * that a schema sync and a reseed are all the boot it needs — or through `SLOTH_WARM_SAME`, when the
 * stack last served the very same issue at the very same head, that nothing is. The stack dies only
 * when its slot leaves the pool (`retention.ts`), when one of its processes is found dead, when
 * `warmSlots` is turned off, or when the slot is leased to a run of another repository — its app is not
 * that one's. A run that ends behind a preview link hands nothing over: the preview owns that stack
 * until `preview.ts` takes it down, and a stack must never have two owners.
 */

export interface WarmState {
  /** The run the stack last served, as a lease names one — `issue-12`, `qa-7`. */
  run: string;
  /** The repository whose app the stack is; a record from before there were several is the legacy repository's. */
  repo?: string;
  /** The branch the worktree was on when the run ended; absent for a detached checkout (a QA run's). */
  branch?: string;
  /** The commit the worktree was on when the run ended — what `SLOTH_WARM_SAME` is decided against. */
  head?: string;
  /** The recorded pids, by the session-directory file they came from. */
  dev: number[];
  redis: number[];
  /** The demo database the stack serves, when the run recorded one. */
  db?: string;
  at: number;
}

const warmFile = (slot: string) => statePath('slots', `${slot}.warm`);

/** The stack a slot keeps warm, if any. */
export function warmOf(slot: string): WarmState | undefined {
  try {
    const w = JSON.parse(readFile(warmFile(slot)) ?? '') as WarmState;
    return { ...w, repo: w.repo ?? legacyRepo() };
  } catch {
    return undefined;
  }
}

const pidsIn = (file: string): number[] =>
  (readFile(file) ?? '')
    .split('\n')
    .map((l) => Number(l.trim()))
    .filter((p) => p > 0);

/**
 * Moves a finished run's stack into its slot's warm state instead of losing it: the pids and database
 * name leave the session directory — `pressure.ts` and the cleanup paths read them there and must not
 * signal or drop what is now the slot's — and the worktree's branch and head are recorded so the next
 * lease can tell a retry from new work. False when there is nothing alive to keep: the caller then
 * cleans up the leftovers as it always has.
 *
 * `tainted` is for a run that was killed rather than ended — hung past its budget, stopped from the
 * monitor. Its servers are as good as anyone's, but its database may hold a mutation it never finished:
 * the stack is kept warm without its head, so the next lease of the same issue reseeds instead of
 * reusing the data untouched.
 */
export async function handOver(r: RunRef, slot: string, tainted = false): Promise<boolean> {
  const dir = dirOf(r);
  const dev = pidsIn(path.join(dir, 'dev.pid'));
  const redis = pidsIn(path.join(dir, 'redis.pid'));
  if (![...dev, ...redis].some(pidAlive)) return false;
  // Before `releaseSlot` detaches it, the worktree still says what the stack was built for.
  const wt = slotWorktree(slot, r.repo);
  const br = await run('git', ['-C', wt, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 30_000 });
  const head = await run('git', ['-C', wt, 'rev-parse', 'HEAD'], { timeout: 30_000 });
  const branch = br.ok && br.out.trim() !== 'HEAD' ? br.out.trim() : undefined;
  const db = readFile(path.join(dir, 'demo.db'))?.trim() || undefined;
  const state: WarmState = { run: runName(r), repo: r.repo, branch, head: !tainted && head.ok ? head.out.trim() : undefined, dev, redis, db, at: nowSec() };
  write(warmFile(slot), JSON.stringify(state));
  for (const name of ['dev.pid', 'redis.pid', 'demo.db']) remove(path.join(dir, name));
  log(`${slot} keeps the stack of ${runName(r)} warm — ${dev.length + redis.length} pid(s)${db ? `, database ${db}` : ''}`);
  return true;
}

/** Takes a slot's warm stack down for good: the processes, the database, the record. */
export async function killWarm(slot: string, reason: string): Promise<void> {
  const w = warmOf(slot);
  if (!w) return;
  remove(warmFile(slot));
  // Like `cleanup.ts`: the whole tree of each server, woken first — a paused process cannot act on SIGTERM.
  for (const pid of [...w.dev, ...w.redis]) await killTree(pid);
  if (w.db) await run('dropdb', ['--if-exists', w.db], { timeout: 60_000 });
  log(`the warm stack of ${slot} taken down (${reason})`);
}

/**
 * Hands a slot's warm stack to the run that just leased it. Every recorded pid must still be alive —
 * a stack with a hole in it is not resumed but killed, and the run boots cold as before — and the stack
 * must be this repository's app: another repository's is killed the same way. A claimed stack's facts go
 * back into the new session's directory under the standing `dev.pid` / `redis.pid` / `demo.db`
 * convention, so the session, `pressure.ts` and the cleanup paths keep reading them where they always
 * have. `same` when the stack last served this very run at `head` — a retry, which reuses everything
 * untouched. Undefined means a cold boot: no warm stack, or one that had to go.
 */
export async function claimWarm(r: RunRef, slot: string, head?: string): Promise<{ same: boolean } | undefined> {
  const w = warmOf(slot);
  if (!w) return undefined;
  // The switch may have been turned off while a stack sat warm: honour it before anything inherits.
  if (!cfg().warmSlots) {
    await killWarm(slot, 'warm slots are off');
    return undefined;
  }
  if (w.repo !== r.repo) {
    await killWarm(slot, `it is the app of ${w.repo}, and the slot goes to a run of ${r.repo}`);
    return undefined;
  }
  if (![...w.dev, ...w.redis].every(pidAlive)) {
    await killWarm(slot, 'one of its processes died');
    return undefined;
  }
  const dir = dirOf(r);
  if (w.dev.length) write(path.join(dir, 'dev.pid'), `${w.dev.join('\n')}\n`);
  if (w.redis.length) write(path.join(dir, 'redis.pid'), `${w.redis.join('\n')}\n`);
  if (w.db) write(path.join(dir, 'demo.db'), w.db);
  remove(warmFile(slot));
  const same = w.run === runName(r) && !!head && !!w.head && w.head === head;
  log(`${slot} hands its warm stack to ${runName(r)}${same ? ' — same issue and head, everything reused' : ''}`);
  return { same };
}
