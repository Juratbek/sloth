import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cfg } from '../server/config';
import { setDry } from '../server/runner/log';
import { leaseSlot, releaseSlot, slotOf } from '../server/runner/slots';
import { cleanup } from '../server/runner/cleanup';
import { launch, launchQa } from '../server/runner/spawn';
import { resetSpawn, spawned } from './child-process-mock';
import { called, fail, onCommand, resetGh } from './gh-mock';
import { alivePid, calmMachine, configure, exists, makeSession, read, readLog, statePath, wipe } from './harness';

vi.mock('../server/runner/gh', () => import('./gh-mock'));
vi.mock('node:child_process', () => import('./child-process-mock'));

const lease = (n: number) => statePath('slots', `slot-${n}`);
const slotDir = (n: number) => path.join(cfg().worktreesDir, `slot-${n}`);

beforeEach(() => {
  configure({ maxActive: 2, maxAlive: 4 });
  wipe();
  resetGh();
  resetSpawn();
  calmMachine();
  setDry(false);
});

describe('leaseSlot', () => {
  it('hands out slot-1 … slot-maxActive, makes the worktree the first time, and keeps a run on its slot', async () => {
    expect(await leaseSlot('issue', 1)).toBe('slot-1');
    expect(read(lease(1)).trim()).toBe('issue-1');
    expect(called(/worktree add --detach .*slot-1 HEAD/)).toHaveLength(1);
    fs.mkdirSync(slotDir(1), { recursive: true }); // what the (mocked) git would have made
    makeSession('issue', 1, { pid: alivePid() });
    expect(await leaseSlot('issue', 1)).toBe('slot-1'); // the same run asks again: same slot, no second worktree
    expect(called(/worktree add/)).toHaveLength(1);
    makeSession('qa', 1, { pid: alivePid() });
    expect(await leaseSlot('qa', 1)).toBe('slot-2');
    expect(await leaseSlot('issue', 3)).toBeUndefined(); // both held by live runs
    expect(slotOf('qa', 1)).toBe('slot-2');
    expect(slotOf('issue', 3)).toBeUndefined();
  });
  it('takes over the slot of a run that is gone, but not of one whose app is up behind a preview', async () => {
    makeSession('issue', 1, { pid: '2000000000' }); // dead
    makeSession('issue', 2, { pid: '2000000000', 'preview-state.json': { issue: 2 } });
    fs.mkdirSync(statePath('slots'), { recursive: true });
    fs.writeFileSync(lease(1), 'issue-1');
    fs.writeFileSync(lease(2), 'issue-2');
    fs.mkdirSync(slotDir(1), { recursive: true });
    expect(await leaseSlot('issue', 3)).toBe('slot-1');
    expect(read(lease(1)).trim()).toBe('issue-3');
    expect(called(/worktree add/)).toHaveLength(0); // the directory exists
    makeSession('issue', 3, { pid: alivePid() });
    expect(await leaseSlot('issue', 4)).toBeUndefined();
  });
  it('gives nothing when the worktree cannot be made', async () => {
    onCommand(/worktree add/, fail('fatal: not a git repository'));
    expect(await leaseSlot('issue', 1)).toBeUndefined();
    expect(exists(lease(1))).toBe(false);
    expect(readLog().join('\n')).toMatch(/slot-1 could not be created: fatal: not a git repository/);
  });
});

describe('releaseSlot', () => {
  it('drops the lease and detaches the worktree; a run without a slot is a no-op', async () => {
    fs.mkdirSync(slotDir(1), { recursive: true });
    await leaseSlot('issue', 1);
    await releaseSlot('issue', 1);
    expect(exists(lease(1))).toBe(false);
    expect(called(/git -C .*slot-1 checkout -q --detach/)).toHaveLength(1);
    await releaseSlot('issue', 9);
    expect(called(/checkout -q --detach/)).toHaveLength(1);
  });
  it('is what cleanup does with the slot, while a leftover per-issue worktree is still removed', async () => {
    makeSession('issue', 1, { pid: '2000000000' });
    await leaseSlot('issue', 1);
    fs.mkdirSync(path.join(cfg().worktreesDir, 'issue-1'), { recursive: true });
    await cleanup(1);
    expect(exists(lease(1))).toBe(false);
    expect(called(/worktree remove .*issue-1 --force/)).toHaveLength(1);
    expect(called(/worktree remove .*slot-1/)).toHaveLength(0);
  });
});

describe('launch with slots', () => {
  it('leases a slot to an implement run and a QA run and points SLOTH_WORKTREE at it', async () => {
    expect(await launch(5)).toBe(true);
    expect(spawned[0].options.env.SLOTH_WORKTREE).toBe(slotDir(1));
    expect(read(lease(1)).trim()).toBe('issue-5');
    fs.writeFileSync(path.join(cfg().sessionsDir, 'issue-5', 'pid'), alivePid());
    expect(await launchQa(5, 'abc1234', 'qa')).toBe(true);
    expect(spawned[1].options.env.SLOTH_WORKTREE).toBe(slotDir(2));
    expect(read(lease(2)).trim()).toBe('qa-5');
  });
  it('queues a run when every slot is held — by previews, which the session caps do not count', async () => {
    makeSession('issue', 1, { pid: '2000000000', 'preview-state.json': { issue: 1 } });
    makeSession('issue', 2, { pid: '2000000000', 'preview-state.json': { issue: 2 } });
    fs.mkdirSync(statePath('slots'), { recursive: true });
    fs.writeFileSync(lease(1), 'issue-1');
    fs.writeFileSync(lease(2), 'issue-2');
    expect(await launch(3)).toBe(false);
    expect(spawned).toHaveLength(0);
    expect(readLog().join('\n')).toMatch(/#3 queued \(no free worktree slot\)/);
  });
  it('gives a review no worktree at all', async () => {
    const { launchApproved } = await import('../server/runner/spawn');
    expect(launchApproved(10, 1)).toBe(true);
    expect(spawned[0].options.env.SLOTH_WORKTREE).toBeUndefined();
  });
});
