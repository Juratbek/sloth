import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The executables this fake machine has; `which` is the only thing standing between the code and a real box. */
const bins = vi.hoisted(() => ({ map: {} as Record<string, string | undefined> }));
vi.mock('../server/install', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/install')>()),
  which: (cmd: string) => bins.map[cmd],
}));
vi.mock('node:child_process', () => import('./child-process-mock'));

import { setDry } from '../server/runner/log';
import { installer, installSteps, handleStack } from '../server/stack';
import { sudoPaths, sudoersRule, systemBinary } from '../server/sudo';
import { executed, onExecFile, resetSpawn, spawned } from './child-process-mock';
import { configure, readLog, wipe } from './harness';

const PASSWORD = 'correct-horse-battery-staple';
const PATHS = { apt: '/usr/bin/apt-get', service: '/usr/sbin/service', systemctl: '/usr/bin/systemctl', createuser: '/usr/bin/createuser' };

/** A Debian box with no Homebrew: apt is there, sudo is there, everything the rule needs is there. */
const debian = () => {
  bins.map = { sudo: '/usr/bin/sudo', 'apt-get': '/usr/bin/apt-get', visudo: '/usr/sbin/visudo', install: '/usr/bin/install' };
  // Sloth's own narrow rule is in force: apt-get with an argument the rule does not name is refused.
  onExecFile(/--sloth-never-grants-this/, { code: 1 });
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
  it('grants the exact install lines by absolute path and argument, and nothing else', () => {
    const rule = sudoersRule('sloth', PATHS);
    expect(rule).toBe(
      "# Written by Sloth so it can install the project's stack without a password: these exact command lines, nothing else.\n" +
        'sloth ALL=(root) NOPASSWD: /usr/bin/apt-get update -q, \\\n' +
        '    /usr/bin/apt-get install -y -q postgresql, \\\n' +
        '    /usr/sbin/service postgresql start, \\\n' +
        '    /usr/bin/systemctl start postgresql, \\\n' +
        '    /usr/bin/apt-get install -y -q redis-server, \\\n' +
        '    /usr/sbin/service redis-server start, \\\n' +
        '    /usr/bin/systemctl start redis-server, \\\n' +
        '    /usr/bin/apt-get install -y -q nodejs npm, \\\n' +
        '    /usr/bin/apt-get install -y -q python3 python3-pip python3-venv, \\\n' +
        '    /usr/bin/apt-get install -y -q default-jdk\n' +
        'sloth ALL=(postgres) NOPASSWD: /usr/bin/createuser -s sloth\n',
    );
  });
  it('never names a program without its arguments — the lines that would be root with an argument of their own', () => {
    const rule = sudoersRule('sloth', PATHS);
    for (const line of rule.split('\n').filter((l) => /NOPASSWD/.test(l) || /^\s+\//.test(l))) {
      for (const cmd of line.replace(/^.*NOPASSWD: /, '').split(/, \\?$|, /).filter(Boolean)) {
        expect(cmd.trim().split(' ').length, cmd).toBeGreaterThan(1);
      }
    }
    expect(rule).not.toMatch(/NOPASSWD: ALL/);
    expect(rule).not.toMatch(/apt-get(, |\n)/);
    expect(rule).not.toMatch(/systemctl(, |\n)/);
    // No variable crosses: a name sudoers could pin, a value it could not.
    expect(rule).not.toMatch(/Defaults|env_keep|SETENV/);
    expect(rule).not.toMatch(/restart/);
  });
  it('runs the same lines it grants: every apt install step is one of the rule\'s entries', () => {
    const user = 'sloth';
    vi.spyOn(os, 'userInfo').mockReturnValue({ username: user, uid: 1000, gid: 1000, shell: '/bin/sh', homedir: '/home/sloth' });
    const granted = sudoersRule(user, PATHS).replace(/\\\n\s+/g, '').split('\n');
    const entries = granted.filter((l) => l.includes('NOPASSWD')).flatMap((l) => l.replace(/^.*NOPASSWD: /, '').split(', '));
    const bin = (cmd: string) => PATHS[cmd === 'apt-get' ? 'apt' : (cmd as keyof typeof PATHS)];
    for (const id of ['postgresql', 'redis', 'node', 'python', 'java'] as const) {
      for (const step of installSteps(id, { kind: 'apt', sudo: true })) {
        const argv = step.args.slice(1).filter((a, i, all) => !(a === '-u' || (i > 0 && all[i - 1] === '-u')));
        expect(entries, `${id}: ${argv.join(' ')}`).toContain([bin(argv[0]), ...argv.slice(1)].join(' '));
      }
    }
  });
  it('refuses a user name that could carry a rule of its own', () => {
    for (const bad of ['', 'Root', '-x', 'ro ot', 'sloth ALL=(ALL) NOPASSWD: ALL', 'sloth\nevil ALL=(ALL) NOPASSWD: ALL'])
      expect(() => sudoersRule(bad, PATHS)).toThrow(/not a user name/);
    expect(() => sudoersRule('_sloth-1', PATHS)).not.toThrow();
  });
  it('names programs from the system directories only, never from PATH, and falls back to the Debian paths', () => {
    // A `service` of the session's own on PATH is not what the rule names.
    bins.map = { 'apt-get': '/home/sloth/.local/bin/apt-get', service: '/home/sloth/.local/bin/service' };
    const rule = sudoersRule('sloth', sudoPaths(['/nonexistent-dir']));
    expect(rule).toContain('/usr/bin/apt-get update -q');
    expect(rule).toContain('/usr/sbin/service postgresql start');
    expect(rule).toContain('/usr/bin/systemctl start postgresql');
    expect(rule).not.toContain('.local');
  });
  it('takes a system binary only when root owns it and nobody else can write it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sloth-bin-'));
    fs.writeFileSync(path.join(dir, 'service'), '#!/bin/sh\ncp /bin/sh /tmp/root-shell\n', { mode: 0o755 });
    // Owned by the test's user, not root: refused, the Debian default is written instead.
    expect(systemBinary('service', '/usr/sbin/service', [dir])).toBe('/usr/sbin/service');
    // A real root-owned system binary, where the machine has one.
    if (fs.existsSync('/usr/sbin/visudo')) expect(systemBinary('visudo', '/usr/sbin/visudo')).toBe('/usr/sbin/visudo');
    // A path sudoers would read as two commands is never written, found or not.
    expect(() => systemBinary('x', '/tmp/a,/bin/sh', [dir])).toThrow(/not a path/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('installer', () => {
  it('takes a sudo that may run apt-get, and asks whether it may run more than Sloth grants', async () => {
    debian();
    expect(await installer()).toEqual({ kind: 'apt', sudo: true, wide: false });
    expect(executed.map((e) => e.line)).toEqual([
      '/usr/bin/sudo -n -l /usr/bin/apt-get update -q',
      '/usr/bin/sudo -n -l /usr/bin/apt-get update --sloth-never-grants-this',
    ]);
  });
  it('flags a sudo wider than the rule — the one an older Sloth wrote — so the page offers to replace it', async () => {
    bins.map = { sudo: '/usr/bin/sudo', 'apt-get': '/usr/bin/apt-get', visudo: '/usr/sbin/visudo', install: '/usr/bin/install' };
    expect(await installer()).toEqual({ kind: 'apt', sudo: true, wide: true });
    const status = await handleStack('/api/stack', 'GET', undefined, undefined);
    expect(status.sudoWide).toBe(true);
    expect(status.installer).toBe('apt');
    expect(status.sudoPassword).toBeUndefined();
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
    expect(spawned[0].options.cwd).toBe(configure().repos[0].root);
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
