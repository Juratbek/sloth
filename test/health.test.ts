import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => import('./child-process-mock'));

import { executed, onExecFile, resetSpawn } from './child-process-mock';
import {
  HEALTH_INTERVAL_MS,
  checkHealth,
  chromeCheck,
  forgetHealth,
  healthStatus,
  healthTick,
  refreshHealth,
  sudoCheck,
} from '../server/health';
import type { Installer } from '../server/stack';
import type { Health, HealthId } from '../server/types';
import { configure, readLog, wipe } from './harness';

/**
 * The four questions the header's chip answers. Two of them shell out and are pinned through the
 * child-process mock; the other two are pure functions taking what the machine has as an argument,
 * because a test must not depend on whether the Mac it runs on happens to have Chrome installed.
 */

const of = (health: Health, id: HealthId) => health.checks.find((c) => c.id === id)!;

/** `gh auth status` and `git ls-remote` both fine — the starting point every case departs from. */
function allWell(): void {
  onExecFile(/gh auth status/, { stdout: 'github.com\n  ✓ Logged in to github.com account octocat' });
  onExecFile(/git ls-remote/, { stdout: 'deadbeef\tHEAD' });
  // No brew and no apt-get: `installer()` then reports "nothing to install with", which is not a fault.
  onExecFile(/sudo/, { code: 1 });
}

describe('checkHealth', () => {
  beforeEach(() => {
    configure();
    wipe();
    resetSpawn();
    forgetHealth();
  });

  it('asks gh, git, the browser and sudo, and says what each one answered', async () => {
    allWell();
    const health = await checkHealth();
    expect(health.checks.map((c) => c.id)).toEqual(['gh', 'git', 'chrome', 'sudo', 'state']);
    expect(health.at).toBeGreaterThan(0);
    expect(of(health, 'gh').ok).toBe(true);
    expect(of(health, 'gh').detail).toContain('Logged in to github.com');
    expect(of(health, 'git').ok).toBe(true);
    expect(of(health, 'git').detail).toContain(configure().runnerRoot);
  });

  it('asks origin from the runner checkout, not from wherever Sloth was started', async () => {
    allWell();
    await checkHealth();
    const line = executed.find((e) => e.line.includes('git ls-remote'))!;
    expect(line.args).toEqual(['ls-remote', '--exit-code', 'origin', 'HEAD']);
  });

  it('carries the failure back in the words the command used', async () => {
    onExecFile(/gh auth status/, { code: 1, stderr: 'You are not logged into any GitHub hosts. To log in, run: gh auth login' });
    onExecFile(/git ls-remote/, { code: 128, stderr: "fatal: 'origin' does not appear to be a git repository" });
    const health = await checkHealth();
    expect(of(health, 'gh').ok).toBe(false);
    expect(of(health, 'gh').detail).toContain('not logged into any GitHub hosts');
    expect(of(health, 'git').ok).toBe(false);
    expect(of(health, 'git').detail).toContain("'origin' does not appear to be a git repository");
  });

  it('says something even when the failing command wrote nothing to either stream', async () => {
    onExecFile(/gh auth status/, { code: 1 });
    onExecFile(/git ls-remote/, { code: 1 });
    const health = await checkHealth();
    // `run()` puts the error itself where the stderr would be, so there is always a line to show.
    expect(of(health, 'gh').detail).not.toBe('');
    expect(of(health, 'git').detail).not.toBe('');
  });

  it('gives every shell-out a timeout of its own, so a hung gh cannot stall the tick', async () => {
    allWell();
    await checkHealth();
    const asked = executed.filter((e) => /gh auth status|git ls-remote/.test(e.line));
    expect(asked).toHaveLength(2);
    // `run()`'s own default is a minute — far too long to hold a tick for an answer worth seconds.
    for (const e of asked) expect(e.options.timeout).toBeLessThanOrEqual(15_000);
  });
});

describe('the browser check', () => {
  it('passes with Chrome and names a Chromium by its path', () => {
    expect(chromeCheck(true, { channel: 'chrome' })).toMatchObject({ id: 'chrome', ok: true, detail: 'Google Chrome' });
    expect(chromeCheck(true, { executable: '/usr/bin/chromium' }).detail).toBe('/usr/bin/chromium');
  });

  it('fails when browser testing is on and there is no browser to do it in', () => {
    const check = chromeCheck(true, undefined);
    expect(check.ok).toBe(false);
    expect(check.skipped).toBeUndefined();
    expect(check.detail).toContain('no Google Chrome or Chromium');
  });

  it('is skipped, not failed, when browser testing is off — the sessions are meant to run without one', () => {
    expect(chromeCheck(false, undefined)).toMatchObject({ ok: true, skipped: true });
  });
});

describe('the sudo check', () => {
  const cases: [string, Installer, { ok: boolean; skipped?: boolean }][] = [
    ['Homebrew, which never asks', { kind: 'brew' }, { ok: true, skipped: true }],
    ['apt-get with the rule in place', { kind: 'apt', sudo: true }, { ok: true }],
    ['apt-get as root', { kind: 'apt', sudo: false }, { ok: true }],
    ['neither brew nor apt-get', { kind: 'none', error: 'no Homebrew and no apt-get on this machine' }, { ok: true, skipped: true }],
  ];
  for (const [what, by, want] of cases) {
    it(`says nothing is wrong with ${what}`, () => {
      expect(sudoCheck(by)).toMatchObject({ id: 'sudo', ...want });
    });
  }

  it('fails on a sudo wider than the exact lines Sloth grants — the rule an older Sloth wrote', () => {
    const check = sudoCheck({ kind: 'apt', sudo: true, wide: true });
    expect(check.ok).toBe(false);
    expect(check.skipped).toBeUndefined();
    expect(check.detail).toMatch(/any arguments — wider than the exact lines Sloth grants/);
  });

  it('fails only where the stack install needs the rule and it is not there', () => {
    const check = sudoCheck({ kind: 'none', error: 'apt-get needs passwordless sudo here', password: true });
    expect(check.ok).toBe(false);
    expect(check.skipped).toBeUndefined();
    expect(check.detail).toContain('passwordless sudo');
  });
});

describe('the cache and the ten-minute gate', () => {
  beforeEach(() => {
    configure();
    wipe();
    resetSpawn();
    forgetHealth();
    allWell();
  });

  const asks = () => executed.filter((e) => e.line.includes('gh auth status')).length;

  it('has nothing to show before the first reading', () => {
    expect(healthStatus()).toBeUndefined();
  });

  it('keeps the last reading and hands it back without asking again', async () => {
    const health = await refreshHealth();
    expect(healthStatus()).toBe(health);
    expect(asks()).toBe(1);
  });

  it('runs one check for two callers at once', async () => {
    const [a, b] = await Promise.all([refreshHealth(), refreshHealth()]);
    expect(a).toBe(b);
    expect(asks()).toBe(1);
  });

  it('re-runs on demand however recently it last ran', async () => {
    await refreshHealth();
    await refreshHealth();
    expect(asks()).toBe(2);
  });

  it('takes the first reading on a tick and then leaves the tick alone for ten minutes', async () => {
    await healthTick();
    expect(asks()).toBe(1);
    await healthTick();
    await healthTick(healthStatus()!.at + HEALTH_INTERVAL_MS - 1000);
    expect(asks()).toBe(1);
    await healthTick(healthStatus()!.at + HEALTH_INTERVAL_MS);
    expect(asks()).toBe(2);
  });

  it('writes a line when something is failing, and does not repeat itself while it stays that way', async () => {
    onExecFile(/gh auth status/, { code: 1, stderr: 'not logged in' });
    await refreshHealth();
    await refreshHealth();
    expect(readLog().filter((l) => l.includes('health: gh —'))).toHaveLength(1);
    // …and says so again when the machine changes its mind.
    onExecFile(/gh auth status/, { stdout: 'Logged in' });
    await refreshHealth();
    expect(readLog().filter((l) => l.includes('every check is in order'))).toHaveLength(1);
  });
});
