import fs from 'node:fs';
import path from 'node:path';
import { cfg } from '../config';
import { run } from './gh';
import { readFile, remove } from './log';
import { dirOf, worktreeName, type Kind } from './session-dirs';
import { releaseSlot } from './slots';

/**
 * What a session's own teardown does, for a run that never got there or one whose environment Sloth kept
 * alive as a preview: stop the processes it recorded, drop its database, give its worktree slot back. Only
 * the pids (and their process groups) and the name written into the session directory are touched — never
 * another run's. A worktree of the old per-issue kind (`issue-<n>`, `qa-<n>`) is removed outright.
 */
export const cleanup = (issue: number): Promise<void> => cleanupRun('issue', issue);

/** The same for any run that boots the app — an implement run, or the QA sweep's test of a card. */
export async function cleanupRun(kind: Kind, target: number): Promise<void> {
  const dir = dirOf(kind, target);
  for (const name of ['dev.pid', 'redis.pid']) {
    const file = path.join(dir, name);
    // One pid per line — a project skill may have started several servers.
    for (const line of (readFile(file) ?? '').split('\n')) {
      const pid = Number(line.trim());
      if (!pid) continue;
      // A server started as its own process group (a `set -m` job, `setsid`) takes its children with
      // it — the dev-server wrappers a project starts fork the real listeners.
      for (const target of [-pid, pid]) {
        try {
          process.kill(target);
        } catch {
          /* no such group, or already gone */
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
  // A cleaned-up run has nothing left to show.
  remove(path.join(dir, 'preview.json'));
  await releaseSlot(kind, target);
  const worktree = path.join(cfg().worktreesDir, worktreeName(kind, target));
  if (fs.existsSync(worktree)) {
    await run('git', ['-C', cfg().runnerRoot, 'worktree', 'remove', worktree, '--force'], 120_000);
    await run('git', ['-C', cfg().runnerRoot, 'worktree', 'prune'], 60_000);
  }
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
