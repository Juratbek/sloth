import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The executables this fake machine has; `which` is the only thing standing between the code and a real box. */
const bins = vi.hoisted(() => ({ map: {} as Record<string, string | undefined> }));
vi.mock('../server/install', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/install')>()),
  which: (cmd: string) => bins.map[cmd],
}));
vi.mock('node:child_process', () => import('./child-process-mock'));

import { setDry } from '../server/runner/log';
import { installer, handleStack } from '../server/stack';
import { sudoersRule } from '../server/sudo';
import { executed, onExecFile, resetSpawn, spawned } from './child-process-mock';
import { configure, readLog, wipe } from './harness';

const PASSWORD = 'correct-horse-battery-staple';
const PATHS = { apt: '/usr/bin/apt-get', service: '/usr/sbin/service', systemctl: '/usr/bin/systemctl', createuser: '/usr/bin/createuser' };

/** A Debian box with no Homebrew: apt is there, sudo is there, everything the rule needs is there. */
const debian = () => {
  bins.map = { sudo: '/usr/bin/sudo', 'apt-get': '/usr/bin/apt-get', visudo: '/usr/sbin/visudo', install: '/usr/bin/install' };
};
const unlock = (body: unknown) => handleStack('/api/stack/unlock', 'POST', undefined, body);
/** Everywhere the password could show up if a line of this feature were wrong. */
const leaks = (status: unknown) => [JSON.stringify(status), readLog().join('\n'), ...executed.map((e) => e.line), ...spawned.map((s) => JSON.stringify(s))];

beforeEach(() => {
  configure();
  wipe();
  resetSpawn();
  setDry(false);
  bins.map = {};
});

describe('sudoersRule', () => {
  it('grants apt-get, service, systemctl and createuser by absolute path, and nothing else', () => {
    expect(sudoersRule('sloth', PATHS)).toBe(
      "# Written by Sloth so it can install the project's stack without a password.\n" +
        'sloth ALL=(root) NOPASSWD: /usr/bin/apt-get, /usr/sbin/service, /usr/bin/systemctl\n' +
        'sloth ALL=(postgres) NOPASSWD: /usr/bin/createuser\n',
    );
  });
  it('refuses a user name that could carry a rule of its own', () => {
    for (const bad of ['', 'Root', '-x', 'ro ot', 'sloth ALL=(ALL) NOPASSWD: ALL', 'sloth\nevil ALL=(ALL) NOPASSWD: ALL'])
      expect(() => sudoersRule(bad, PATHS)).toThrow(/not a user name/);
    expect(() => sudoersRule('_sloth-1', PATHS)).not.toThrow();
  });
  it('resolves what this machine has, and falls back to the Debian paths for what it does not', () => {
    bins.map = { 'apt-get': '/opt/bin/apt-get' };
    expect(sudoersRule('sloth')).toContain('/opt/bin/apt-get, /usr/sbin/service, /usr/bin/systemctl');
  });
});

describe('installer', () => {
  it('takes a sudo that may run apt-get — the scoped rule as well as a full NOPASSWD line', async () => {
    debian();
    expect(await installer()).toEqual({ kind: 'apt', sudo: true });
    expect(executed.map((e) => e.line)).toEqual(['/usr/bin/sudo -n -l /usr/bin/apt-get']);
  });
  it('says a password would unlock it when that probe is refused', async () => {
    debian();
    onExecFile(/-n -l/, { code: 1 });
    expect(await installer()).toMatchObject({ kind: 'none', password: true });
    const status = await handleStack('/api/stack', 'GET', undefined, undefined);
    expect(status.sudoPassword).toBe(true);
    expect(status.installer).toBeUndefined();
  });
});

describe('POST /api/stack/install', () => {
  it('reads `auto` as what the configured stack still lacks, like the unlock path — not as nothing', async () => {
    debian();
    configure({ stack: ['redis'] });
    const status = await handleStack('/api/stack/install', 'POST', undefined, { ids: 'auto', ai: true });
    expect(status.installError).toBeUndefined();
    expect(spawned).toHaveLength(1);
    expect(spawned[0].args).toContain('/sloth:stack redis');
  });
});

describe('POST /api/stack/unlock', () => {
  it('refuses an empty or absent password without touching sudo', async () => {
    debian();
    for (const body of [{}, { password: '' }, { password: '   ' }, { password: 7 }]) {
      expect((await unlock(body)).installError).toBe('a password is needed');
      expect(executed.some((e) => e.line.includes('-S'))).toBe(false);
      expect(spawned).toHaveLength(0);
    }
  });

  it('stops at a wrong password, writes nothing and never repeats it', async () => {
    debian();
    onExecFile(/-S -k/, { code: 1, stderr: 'sudo: 1 incorrect password attempt' });
    const status = await unlock({ password: PASSWORD, ids: ['redis'] });
    expect(status.installError).toBe('wrong password');
    expect(spawned).toHaveLength(0);
    // The one verify call, and it is the only place the password went — down the child's stdin.
    expect(executed.filter((e) => e.stdin.includes(PASSWORD))).toHaveLength(1);
    for (const text of leaks(status)) expect(text).not.toContain(PASSWORD);
  });

  it('writes the rule through visudo and hands the install to an AI session', async () => {
    debian();
    const status = await unlock({ password: PASSWORD, ids: ['redis'] });
    expect(status.installError).toBeUndefined();
    const lines = executed.map((e) => e.line);
    // Checked before it can do any harm, installed 0440 root:root, checked again where it now lives.
    expect(lines.some((l) => /visudo -cf .*sloth-sudoers/.test(l))).toBe(true);
    expect(lines.some((l) => /install -m 0440 -o root -g root .* \/etc\/sudoers\.d\/sloth$/.test(l))).toBe(true);
    expect(lines.some((l) => l.endsWith('visudo -cf /etc/sudoers.d/sloth'))).toBe(true);
    expect(lines.some((l) => l.includes('rm -f'))).toBe(false);
    // …and the session that installs Redis, on the implement model, in its own non-board directory.
    expect(spawned).toHaveLength(1);
    expect(spawned[0].args).toContain('/sloth:stack redis');
    expect(spawned[0].options.env.SLOTH_STACK_INSTALL).toBe('redis');
    expect(spawned[0].options.cwd).toBe(configure().runnerRoot);
    expect(status.install.sessionId).toEqual(expect.any(String));
    for (const text of leaks(status)) expect(text).not.toContain(PASSWORD);
  });

  it('takes the file away again when the installed rule does not parse', async () => {
    debian();
    onExecFile(/visudo -cf \/etc\/sudoers\.d\/sloth$/, { code: 1, stderr: 'parse error near line 2' });
    const status = await unlock({ password: PASSWORD, ids: ['redis'] });
    expect(status.installError).toMatch(/removed — parse error near line 2/);
    expect(executed.some((e) => e.line.endsWith('rm -f /etc/sudoers.d/sloth'))).toBe(true);
    expect(spawned).toHaveLength(0);
  });

  it('runs no sudo and starts nothing in a dry run', async () => {
    debian();
    setDry(true);
    const status = await unlock({ password: PASSWORD, ids: ['redis'] });
    expect(status.installError).toBeUndefined();
    expect(executed.some((e) => e.line.includes('-S'))).toBe(false);
    expect(spawned).toHaveLength(0);
    expect(readLog().join('\n')).toMatch(/would write \/etc\/sudoers\.d\/sloth/);
    expect(readLog().join('\n')).toMatch(/would start an install session for Redis/);
    for (const text of leaks(status)) expect(text).not.toContain(PASSWORD);
  });
});
