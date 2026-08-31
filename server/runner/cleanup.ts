import fs from 'node:fs';
import path from 'node:path';
import { cfg } from '../config';
import { run } from './gh';
import { readFile, remove } from './log';
import { dirOf, worktreeName, type Kind } from './session-dirs';
import { releaseSlot, slotOf } from './slots';
import { handOver } from './warm';

/**
 * What a session's own teardown does, for a run that never got there or one whose environment Sloth kept
 * alive as a preview: stop the processes it recorded, drop its database, give its worktree slot back. Only
 * the pids (and their process groups) and the name written into the session directory are touched — never
 * another run's. A worktree of the old per-issue kind (`issue-<n>`, `qa-<n>`) is removed outright.
 *
 * With `warmSlots` on the stopping and the dropping are the exception, not the rule: a run that still
 * holds a pool slot hands its live stack to that slot instead (`warm.ts`), and the next lease inherits
 * it. Only a run whose app was kept up for a preview — that stack is the preview's until `preview.ts`
 * takes it down — or one with nothing left alive is cleaned up the old way.
 */
export const cleanup = (issue: number, tainted = false): Promise<void> => cleanupRun('issue', issue, tainted);

/** Whether the run handed its app over to a preview — written at teardown, or once the tunnel is up. */
const previewed = (dir: string) => fs.existsSync(path.join(dir, 'preview.json')) || fs.existsSync(path.join(dir, 'preview-state.json'));

/**
 * The same for any run that boots the app — an implement run, or the QA sweep's test of a card.
 * `tainted` marks a run that was killed rather than ended (`warm.ts`): its stack still warms the slot,
 * but without its head, so a retry reseeds the database instead of trusting what the kill interrupted.
 */
export async function cleanupRun(kind: Kind, target: number, tainted = false): Promise<void> {
  const dir = dirOf(kind, target);
  const slot = cfg().warmSlots && !previewed(dir) ? slotOf(kind, target) : undefined;
  if (!(slot && (await handOver(kind, target, slot, tainted)))) {
    for (const name of ['dev.pid', 'redis.pid']) {
      const file = path.join(dir, name);
      // One pid per line — a project skill may have started several servers.
      for (const line of (readFile(file) ?? '').split('\n')) {
        const pid = Number(line.trim());
        if (!pid) continue;
        // A server started as its own process group (a `set -m` job, `setsid`) takes its children with
        // it — the dev-server wrappers a project starts fork the real listeners. One that was paused for
        // the machine's sake is stopped cold and has to be woken first, or the SIGTERM waits with it.
        for (const target of [-pid, pid]) {
          for (const signal of ['SIGCONT', 'SIGTERM'] as const) {
            try {
              process.kill(target, signal);
            } catch {
              /* no such group, or already gone */
            }
          }
        }
      }
      remove(file);
    }
    const db = readFile(path.join(dir, 'demo.db'))?.trim();
    if (db) {
      await run('dropdb', ['--if-exists', db], 60_000);
      remove(path.join(dir, 'demo.db'));
    }
  }
  // A cleaned-up run has nothing left to show.
  remove(path.join(dir, 'preview.json'));
  await releaseSlot(kind, target);
  const worktree = path.join(cfg().worktreesDir, worktreeName(kind, target));
  if (fs.existsSync(worktree)) {
    await run('git', ['-C', cfg().runnerRoot, 'worktree', 'remove', worktree, '--force'], 120_000);
    await run('git', ['-C', cfg().runnerRoot, 'worktree', 'prune'], 60_000);
  }
}

/**
 * A run that ended on its own terms — teardown done, `state` no longer `working` — used to leave nothing
 * behind: the session killed its own servers. Under the warm-slots contract it leaves them running
 * instead, and `reap` calls this when it forgets such a run's pid: the stack moves to the slot and the
 * slot goes back to the pool. A previewing run keeps today's hand-off, and with `warmSlots` off the
 * session tore everything down itself, so in both cases there is nothing here to keep.
 */
export async function keepWarm(kind: Kind, target: number): Promise<void> {
  if (!cfg().warmSlots) return;
  const dir = dirOf(kind, target);
  if (previewed(dir)) return;
  const slot = slotOf(kind, target);
  if (slot && (await handOver(kind, target, slot))) await releaseSlot(kind, target);
}

/** Whether any process the session recorded in `dev.pid` still runs; a run that recorded none counts as up. */
export function serversUp(issue: number): boolean {
  const pids = (readFile(path.join(dirOf('issue', issue), 'dev.pid')) ?? '')
    .split('\n')
    .map((l) => Number(l.trim()))
    .filter(Boolean);
  if (!pids.length) return true;
  return pids.some((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
}
