import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setDry } from '../server/runner/log';
import { prune } from '../server/runner/retention';
import { called, fail, onCommand, resetGh } from './gh-mock';
import { cfg } from '../server/config';
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
    makeSession('issue', 3, { pid: alivePid(), 'run.log': 'fresh' });
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

  it('deletes the transcript of a pruned run and of a pruned status reply, and keeps the others', async () => {
    const t = cfg().transcriptsDir;
    fs.mkdirSync(path.join(t, 'aaa', 'subagents'), { recursive: true });
    for (const id of ['aaa', 'bbb', 'ccc']) fs.writeFileSync(path.join(t, `${id}.jsonl`), '{}\n');
    fs.writeFileSync(path.join(t, 'aaa', 'subagents', 'agent-1.jsonl'), '{}\n');
    age(makeSession('issue', 1, { session_id: 'aaa\n', 'run.log': 'old' }), 40);
    makeSession('issue', 2, { session_id: 'bbb', 'run.log': 'fresh' });
    fs.mkdirSync(statePath('status', '1-99'), { recursive: true });
    fs.writeFileSync(statePath('status', '1-99', 'session_id'), 'ccc');
    age(statePath('status', '1-99'), 40);

    await prune();

    expect(exists(t, 'aaa.jsonl')).toBe(false);
    expect(exists(t, 'aaa')).toBe(false);
    expect(exists(t, 'bbb.jsonl')).toBe(true);
    expect(exists(t, 'ccc.jsonl')).toBe(false);
  });

  it('removes a per-issue worktree as soon as its run is over, however young', async () => {
    makeSession('issue', 1, { 'state.json': { state: 'done' }, 'run.log': 'just finished' });
    makeSession('qa', 2, { pid: alivePid() });
    makeWorktree(1);
    fs.mkdirSync(path.join(cfg().worktreesDir, 'qa-2'), { recursive: true });
    await prune();
    expect(called(/worktree remove .*issue-1 --force/)).toHaveLength(1);
    expect(called(/worktree remove .*qa-2/)).toHaveLength(0);
    expect(exists(sessionDir('issue', 1))).toBe(true); // the session directory keeps its keepDays
  });

  it('removes a pool slot past maxActive that nobody holds, keeps the pool and a held slot', async () => {
    configure({ keepDays: 30, maxActive: 2 });
    for (const n of [1, 2, 3, 4]) fs.mkdirSync(path.join(cfg().worktreesDir, `slot-${n}`), { recursive: true });
    fs.mkdirSync(statePath('slots'), { recursive: true });
    fs.writeFileSync(statePath('slots', 'slot-3'), 'issue-7');
    fs.writeFileSync(statePath('slots', 'slot-4'), 'issue-8');
    makeSession('issue', 7, { pid: alivePid() });
    await prune();
    expect(called(/worktree remove .*slot-1/)).toHaveLength(0);
    expect(called(/worktree remove .*slot-2/)).toHaveLength(0);
    expect(called(/worktree remove .*slot-3/)).toHaveLength(0); // held by a live run
    expect(called(/worktree remove .*slot-4 --force/)).toHaveLength(1);
    expect(exists(statePath('slots', 'slot-4'))).toBe(false);
    expect(exists(statePath('slots', 'slot-3'))).toBe(true);
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

  it('deletes a worktree git has already forgotten, instead of failing on it for ever', async () => {
    makeSession('issue', 1, { 'state.json': { state: 'done' }, 'run.log': 'done' });
    const dir = makeWorktree(1);
    onCommand(/worktree remove/, fail(`fatal: '${dir}' is not a working tree`));
    await prune();
    expect(exists(dir)).toBe(false);
    expect(readLog().join('\n')).toMatch(/worktree issue-1 deleted — git has no record of it/);
  });

  it('leaves a worktree whose removal failed for any other reason to the next sweep', async () => {
    makeSession('issue', 1, { 'state.json': { state: 'done' }, 'run.log': 'done' });
    const dir = makeWorktree(1);
    onCommand(/worktree remove/, fail('fatal: Unable to read current working directory'));
    await prune();
    expect(exists(dir)).toBe(true);
    expect(readLog().join('\n')).toMatch(/worktree issue-1 could not be removed/);
  });

  it('cuts a build cache back to its size cap, oldest entry first', async () => {
    const cache = path.join(cfg().runnerRoot, '.turbo', 'cache');
    fs.mkdirSync(cache, { recursive: true });
    // Three 256 MB entries against a 512 MB cap: the oldest one goes and the two newest stay. Sparse,
    // so the test costs no disk — the sweep goes by the size the entry reports.
    for (const [name, days] of [['old', 3] as const, ['mid', 2] as const, ['new', 1] as const]) {
      const file = path.join(cache, `${name}.tar.zst`);
      fs.writeFileSync(file, '');
      fs.truncateSync(file, 256 << 20);
      age(file, days);
    }
    await prune();
    expect(fs.readdirSync(cache).sort()).toEqual(['mid.tar.zst', 'new.tar.zst']);
    expect(readLog().join('\n')).toMatch(/pruned 1 entry \(256 MB\) from runner\/\.turbo\/cache/);
  });

  it('leaves a build cache under the cap alone', async () => {
    const cache = path.join(cfg().worktreesDir, 'slot-1', '.turbo', 'cache');
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(path.join(cache, 'a.tar.zst'), Buffer.alloc(1 << 20));
    await prune();
    expect(fs.readdirSync(cache)).toEqual(['a.tar.zst']);
  });

  it('trims the server logs of a finished run to their tail, and leaves a live run alone', async () => {
    const done = makeSession('issue', 1, { 'state.json': { state: 'done' }, 'run.log': 'short' });
    fs.writeFileSync(path.join(done, 'dev.log'), `${'x'.repeat(3 << 20)}THE END`);
    const live = makeSession('issue', 2, { pid: alivePid() });
    fs.writeFileSync(path.join(live, 'dev.log'), 'y'.repeat(3 << 20));

    await prune();

    const trimmed = fs.readFileSync(path.join(done, 'dev.log'), 'utf8');
    expect(trimmed.length).toBeLessThan((2 << 20) + 100);
    expect(trimmed.startsWith('… 1 MB trimmed by Sloth')).toBe(true);
    expect(trimmed.endsWith('THE END')).toBe(true);
    expect(fs.statSync(path.join(live, 'dev.log')).size).toBe(3 << 20);
    expect(readLog().join('\n')).toMatch(/trimmed dev\.log of issue-1 by 1 MB/);
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
    expect(lines).toMatch(/dry-run: would remove the worktree issue-1/);
    expect(lines).toMatch(/dry-run: would prune 1 seen marker/);
  });
});
