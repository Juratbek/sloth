import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cfg } from '../server/config';
import { setDry } from '../server/runner/log';
import { cleanupRun, keepWarm } from '../server/runner/cleanup';
import { prune } from '../server/runner/retention';
import { leaseSlot } from '../server/runner/slots';
import { launch } from '../server/runner/spawn';
import { launchQa } from '../server/runner/spawn-tests';
import { reap } from '../server/runner/triggers';
import { warmOf } from '../server/runner/warm';
import { resetSpawn, spawned } from './child-process-mock';
import { called, onCommand, resetGh } from './gh-mock';
import { alivePid, calmMachine, configure, exists, makeSession, read, sessionDir, statePath, wipe } from './harness';

vi.mock('../server/runner/gh', () => import('./gh-mock'));
vi.mock('node:child_process', () => import('./child-process-mock'));

// A pid that is alive *and* safe to kill: a real `sleep`, spawned past the mock. `alivePid()` — this
// very process — only serves the paths that must not kill anything.
const real = await vi.importActual<typeof import('node:child_process')>('node:child_process');
const sleepers: ReturnType<typeof real.spawn>[] = [];
function sleeper(): number {
  const child = real.spawn('sleep', ['60'], { stdio: 'ignore' });
  sleepers.push(child);
  return child.pid!;
}
async function waitDead(pid: number): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

const slotDir = (n: number) => path.join(cfg().worktreesDir, `slot-${n}`);
const warmFile = (n: number) => statePath('slots', `slot-${n}.warm`);

beforeEach(() => {
  configure({ maxActive: 2, maxAlive: 4 });
  wipe();
  resetGh();
  resetSpawn();
  calmMachine();
  setDry(false);
});

afterEach(() => {
  for (const s of sleepers) {
    try {
      s.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  sleepers.length = 0;
});

describe('handing a stack over', () => {
  it('a finished run leaves its pids and database to the slot — nothing killed, nothing dropped', async () => {
    makeSession('issue', 1, { 'dev.pid': `${alivePid()}\n`, 'redis.pid': `${alivePid()}\n`, 'demo.db': 'demo_1\n' });
    await leaseSlot('issue', 1);
    fs.mkdirSync(slotDir(1), { recursive: true });
    onCommand(/rev-parse --abbrev-ref HEAD/, 'sloth/issue-1-fix\n');
    onCommand(/rev-parse HEAD/, 'abc123\n');
    await cleanupRun('issue', 1);
    const w = warmOf('slot-1')!;
    expect(w.run).toBe('issue-1');
    expect(w.dev).toEqual([Number(alivePid())]);
    expect(w.redis).toEqual([Number(alivePid())]);
    expect(w.db).toBe('demo_1');
    expect(w.branch).toBe('sloth/issue-1-fix');
    expect(w.head).toBe('abc123');
    expect(called(/dropdb/)).toHaveLength(0);
    // The facts left the session directory with the stack: nothing there for pressure or cleanup to touch.
    expect(exists(sessionDir('issue', 1), 'dev.pid')).toBe(false);
    expect(exists(sessionDir('issue', 1), 'redis.pid')).toBe(false);
    expect(exists(sessionDir('issue', 1), 'demo.db')).toBe(false);
  });

  it('reap keeps a cleanly ended run warm and returns its slot to the pool', async () => {
    makeSession('issue', 2, { pid: '2000000000', 'state.json': { state: 'done' }, 'dev.pid': `${alivePid()}\n`, 'demo.db': 'demo_2\n' });
    await leaseSlot('issue', 2);
    fs.mkdirSync(slotDir(1), { recursive: true });
    await reap();
    expect(warmOf('slot-1')?.run).toBe('issue-2');
    expect(exists(statePath('slots', 'slot-1'))).toBe(false); // the lease went with the run
    expect(called(/dropdb/)).toHaveLength(0);
  });

  it('a run that ends behind a preview hands nothing over — the preview owns that stack', async () => {
    const pid = sleeper();
    makeSession('issue', 3, { 'dev.pid': `${pid}\n`, 'demo.db': 'demo_3\n', 'preview.json': { url: 'http://localhost:3000' } });
    await leaseSlot('issue', 3);
    await keepWarm('issue', 3);
    expect(warmOf('slot-1')).toBeUndefined();
    // When the preview comes down, its cleanup kills and drops as it always has.
    await cleanupRun('issue', 3);
    expect(warmOf('slot-1')).toBeUndefined();
    expect(called(/dropdb --if-exists demo_3/)).toHaveLength(1);
    expect(await waitDead(pid)).toBe(true);
  });

  it('warmSlots off is exactly today: the stack is killed and the database dropped', async () => {
    configure({ maxActive: 2, warmSlots: false });
    const pid = sleeper();
    makeSession('issue', 4, { 'dev.pid': `${pid}\n`, 'demo.db': 'demo_4\n' });
    await leaseSlot('issue', 4);
    await cleanupRun('issue', 4);
    expect(warmOf('slot-1')).toBeUndefined();
    expect(called(/dropdb --if-exists demo_4/)).toHaveLength(1);
    expect(await waitDead(pid)).toBe(true);
  });
});

describe('claiming a stack', () => {
  it('the next run on the same issue and head inherits everything and is told so', async () => {
    makeSession('issue', 5, { 'dev.pid': `${alivePid()}\n`, 'demo.db': 'demo_5\n' });
    await leaseSlot('issue', 5);
    fs.mkdirSync(slotDir(1), { recursive: true });
    onCommand(/rev-parse --abbrev-ref HEAD/, 'sloth/issue-5-fix\n');
    onCommand(/rev-parse origin\/sloth\/issue-5-fix/, 'abc123\n');
    onCommand(/rev-parse HEAD/, 'abc123\n');
    await cleanupRun('issue', 5);
    expect(await launch(5)).toBe(true);
    const env = spawned[0].options.env;
    expect(env.SLOTH_WARM).toBe('1');
    expect(env.SLOTH_WARM_SAME).toBe('1');
    expect(env.SLOTH_WORKTREE).toBe(slotDir(1));
    // The facts are back in the new session's directory under the standing convention.
    expect(read(path.join(sessionDir('issue', 5), 'dev.pid')).trim()).toBe(alivePid());
    expect(read(path.join(sessionDir('issue', 5), 'demo.db'))).toBe('demo_5');
    expect(exists(warmFile(1))).toBe(false);
  });

  it('the same stack on a moved head is inherited as warm, not as same', async () => {
    makeSession('issue', 6, { 'dev.pid': `${alivePid()}\n`, 'demo.db': 'demo_6\n' });
    await leaseSlot('issue', 6);
    fs.mkdirSync(slotDir(1), { recursive: true });
    onCommand(/rev-parse --abbrev-ref HEAD/, 'sloth/issue-6-fix\n');
    onCommand(/rev-parse origin\/sloth\/issue-6-fix/, 'def456\n'); // the branch moved since the stack was built
    onCommand(/rev-parse HEAD/, 'abc123\n');
    await cleanupRun('issue', 6);
    expect(await launch(6)).toBe(true);
    const env = spawned[0].options.env;
    expect(env.SLOTH_WARM).toBe('1');
    expect(env.SLOTH_WARM_SAME).toBeUndefined();
  });

  it('a killed run warms the slot tainted — inherited on the same head as warm, never as same', async () => {
    makeSession('issue', 9, { 'dev.pid': `${alivePid()}\n`, 'demo.db': 'demo_9\n' });
    await leaseSlot('issue', 9);
    fs.mkdirSync(slotDir(1), { recursive: true });
    onCommand(/rev-parse --abbrev-ref HEAD/, 'sloth/issue-9-fix\n');
    onCommand(/rev-parse origin\/sloth\/issue-9-fix/, 'abc123\n');
    onCommand(/rev-parse HEAD/, 'abc123\n'); // the head never moved — only the kill taints it
    await cleanupRun('issue', 9, true); // what `stop` does for a hung or stopped run
    expect(warmOf('slot-1')?.head).toBeUndefined();
    expect(await launch(9)).toBe(true);
    const env = spawned[0].options.env;
    expect(env.SLOTH_WARM).toBe('1');
    expect(env.SLOTH_WARM_SAME).toBeUndefined(); // the retry reseeds instead of trusting the interrupted data
  });

  it('a warm stack with a dead process is taken down whole and the run boots cold', async () => {
    const pid = sleeper(); // the survivor, killed along with the rest
    fs.mkdirSync(slotDir(1), { recursive: true });
    fs.mkdirSync(statePath('slots'), { recursive: true });
    fs.writeFileSync(warmFile(1), JSON.stringify({ run: 'qa-7', head: 'abc123', dev: [2_000_000_000], redis: [pid], db: 'demo_7', at: 0 }));
    expect(await launchQa(7, 'abc123', 'qa')).toBe(true);
    expect(called(/dropdb --if-exists demo_7/)).toHaveLength(1);
    expect(await waitDead(pid)).toBe(true);
    const env = spawned[0].options.env;
    expect(env.SLOTH_WARM).toBeUndefined();
    expect(env.SLOTH_WARM_SAME).toBeUndefined();
    expect(exists(warmFile(1))).toBe(false);
    expect(exists(sessionDir('qa', 7), 'demo.db')).toBe(false);
  });
});

describe('pruning', () => {
  it('a slot pruned from the pool takes its warm stack down with it', async () => {
    configure({ maxActive: 1 });
    const pid = sleeper();
    fs.mkdirSync(path.join(cfg().worktreesDir, 'slot-2'), { recursive: true });
    fs.mkdirSync(statePath('slots'), { recursive: true });
    fs.writeFileSync(warmFile(2), JSON.stringify({ run: 'issue-9', dev: [pid], redis: [], db: 'demo_9', at: 0 }));
    await prune();
    expect(exists(warmFile(2))).toBe(false);
    expect(called(/dropdb --if-exists demo_9/)).toHaveLength(1);
    expect(await waitDead(pid)).toBe(true);
  });
});
