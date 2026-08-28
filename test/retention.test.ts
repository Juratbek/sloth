import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setDry } from '../server/runner/log';
import { prune } from '../server/runner/retention';
import { called, resetGh } from './gh-mock';
import { alivePid, configure, exists, makeSession, readLog, sessionDir, statePath, wipe } from './harness';

vi.mock('../server/runner/gh', () => import('./gh-mock'));

const DAY = 24 * 3600;
/** Backdates everything under a path by `days`, so it looks like a run nobody has touched since. */
function age(target: string, days: number): void {
  const when = new Date(Date.now() - days * DAY * 1000);
  if (fs.statSync(target).isDirectory()) for (const name of fs.readdirSync(target)) age(path.join(target, name), days);
  fs.utimesSync(target, when, when);
}

const worktree = (issue: number) => path.join(configure().worktreesDir, `issue-${issue}`);
const makeWorktree = (issue: number) => {
  fs.mkdirSync(worktree(issue), { recursive: true });
  return worktree(issue);
};

beforeEach(() => {
  configure({ keepDays: 30 });
  wipe();
  resetGh();
  setDry(false);
});

describe('prune', () => {
  it('deletes the directories and markers of runs nobody has touched in keepDays', async () => {
    age(makeSession('issue', 1, { 'state.json': { state: 'done' }, 'run.log': 'old' }), 40);
    age(makeSession('review', 2, { 'run.log': 'old' }), 40);
    makeSession('issue', 3, { 'run.log': 'fresh' });
    age(makeWorktree(1), 40);
    makeWorktree(3);
    fs.mkdirSync(statePath('status', '1-99'), { recursive: true });
    fs.mkdirSync(statePath('seen'), { recursive: true });
    fs.writeFileSync(statePath('seen', '111'), '');
    fs.writeFileSync(statePath('seen', '222'), '');
    age(statePath('status', '1-99'), 40);
    age(statePath('seen', '111'), 40);

    await prune();

    expect(exists(sessionDir('issue', 1))).toBe(false);
    expect(exists(sessionDir('review', 2))).toBe(false);
    expect(exists(sessionDir('issue', 3))).toBe(true);
    expect(called(/git -C .* worktree remove .*issue-1 --force/)).toHaveLength(1);
    expect(called(/worktree prune/)).toHaveLength(1);
    expect(called(/worktree remove .*issue-3/)).toHaveLength(0);
    expect(exists(statePath('status', '1-99'))).toBe(false);
    expect(exists(statePath('seen', '111'))).toBe(false);
    expect(exists(statePath('seen', '222'))).toBe(true);
    expect(readLog().join('\n')).toMatch(/pruned session issue-1/);
  });

  it('keeps a live run, a run still serving a preview and anything younger than keepDays', async () => {
    age(makeSession('issue', 1, { pid: alivePid() }), 40);
    age(makeSession('issue', 2, { 'preview-state.json': { issue: 2 } }), 40);
    age(makeSession('approved', 3, {}), 10);
    age(makeWorktree(1), 40);
    age(makeWorktree(2), 40);

    await prune();

    expect(exists(sessionDir('issue', 1))).toBe(true);
    expect(exists(sessionDir('issue', 2))).toBe(true);
    expect(exists(sessionDir('approved', 3))).toBe(true);
    expect(called(/worktree remove/)).toHaveLength(0);
  });

  it('sweeps at most once an hour', async () => {
    await prune();
    age(makeSession('issue', 1, {}), 40);
    await prune();
    expect(exists(sessionDir('issue', 1))).toBe(true);
    fs.writeFileSync(statePath('pruned_at'), String(Math.floor(Date.now() / 1000) - 7200));
    await prune();
    expect(exists(sessionDir('issue', 1))).toBe(false);
  });

  it('rotates the watcher log past 5 MB, keeping one copy', async () => {
    const c = configure();
    fs.writeFileSync(c.watcherLog, 'x'.repeat((5 << 20) + 1));
    await prune();
    expect(fs.readFileSync(`${c.watcherLog}.1`, 'utf8')).toHaveLength((5 << 20) + 1);
    expect(readLog().join('\n')).toMatch(/rotated the watcher log at 5 MB/);
  });

  it('only logs in a dry run, and does not remember the sweep', async () => {
    setDry(true);
    age(makeSession('issue', 1, {}), 40);
    age(makeWorktree(1), 40);
    fs.mkdirSync(statePath('seen'), { recursive: true });
    fs.writeFileSync(statePath('seen', '111'), '');
    age(statePath('seen', '111'), 40);

    await prune();

    expect(exists(sessionDir('issue', 1))).toBe(true);
    expect(exists(statePath('seen', '111'))).toBe(true);
    expect(exists(statePath('pruned_at'))).toBe(false);
    expect(called(/worktree/)).toHaveLength(0);
    const lines = readLog().join('\n');
    expect(lines).toMatch(/dry-run: would delete the session directory of issue-1/);
    expect(lines).toMatch(/dry-run: would remove the worktree of #1/);
    expect(lines).toMatch(/dry-run: would prune 1 seen marker/);
  });
});
