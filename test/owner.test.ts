import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeConfig } from '../server/config-file';
import { CONFIG_PATH } from '../server/config';
import { SLOTH_HOME } from '../server/env';
import { claimState, ownerConflict, releaseState } from '../server/runner/owner';
import { startLoop, stopLoop } from '../server/runner/loop';
import { checkHealth } from '../server/health';
import { configure, readLog, statePath, wipe } from './harness';

vi.mock('../server/runner/gh', () => import('./gh-mock'));
vi.mock('node:child_process', () => import('./child-process-mock'));

beforeEach(() => {
  configure();
  wipe();
  stopLoop();
});

describe('an instance’s home', () => {
  it('defaults every directory beside the config file, not under ~/.sloth', () => {
    const c = normalizeConfig({ repo: 'acme/widgets', project: { id: 'p', owner: 'acme', title: 't' }, statusField: { id: 'f', columns: { pickup: { id: 'a', name: 'Todo' }, inProgress: { id: 'b', name: 'In Progress' }, codeReview: { id: 'c', name: 'Code Review' } } } });
    expect(SLOTH_HOME).toBe(path.dirname(CONFIG_PATH));
    expect(c.stateDir).toBe(path.join(SLOTH_HOME, 'state'));
    expect(c.sessionsDir).toBe(path.join(SLOTH_HOME, 'sessions/widgets'));
    expect(c.worktreesDir).toBe(path.join(SLOTH_HOME, 'worktrees/widgets'));
    expect(c.runnersDir).toBe(path.join(SLOTH_HOME, 'runners'));
    expect(c.watcherLog).toBe(path.join(SLOTH_HOME, 'watcher.log'));
  });
});

describe('the state directory owner', () => {
  it('is claimed by this process, and released when the loop stops', () => {
    expect(claimState()).toBe(true);
    const owner = JSON.parse(fs.readFileSync(statePath('owner.json'), 'utf8'));
    expect(owner).toMatchObject({ pid: process.pid, config: CONFIG_PATH });
    releaseState();
    expect(fs.existsSync(statePath('owner.json'))).toBe(false);
  });
  it('refuses a directory another live Sloth holds under a different config, and the health chip says so', async () => {
    fs.writeFileSync(statePath('owner.json'), JSON.stringify({ pid: process.ppid, port: 4400, config: '/elsewhere/config.json', at: Date.now() }));
    startLoop();
    expect(ownerConflict()).toMatch(/belongs to the Sloth running from \/elsewhere\/config\.json/);
    expect(readLog().at(-1)).toMatch(/not watching: the state directory/);
    const health = await checkHealth();
    expect(health.checks.find((c) => c.id === 'state')).toMatchObject({ ok: false });
    // A dead instance's claim counts for nothing.
    fs.writeFileSync(statePath('owner.json'), JSON.stringify({ pid: 999999999, port: 4400, config: '/elsewhere/config.json', at: Date.now() }));
    expect(claimState()).toBe(true);
    expect(ownerConflict()).toBeUndefined();
    stopLoop();
  });
});
