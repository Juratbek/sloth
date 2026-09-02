import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from './exec';
import { which } from './install';
import { isDry, log } from './runner/log';

/**
 * The one place a sudo password is ever touched. A Sloth on a Linux box runs as an ordinary user, so
 * `apt-get` is out of reach and the stack never gets installed. The Stack page asks for that user's
 * password **once**: it is used here, in this process, for the few seconds it takes to write
 * `/etc/sudoers.d/sloth` — the four commands installing the stack needs, nothing else — and is then
 * gone. It is never stored, never logged, never put in the environment and never handed to a session:
 * it only ever travels down a child's stdin (`sudo -S`), which is why every call below goes through
 * `sudoWith`.
 */

const SUDOERS = '/etc/sudoers.d/sloth';
/** sudo's own idea of a user name; anything else could smuggle a newline (and a rule) into sudoers. */
const USER = /^[a-z_][a-z0-9_-]*$/;

/** The commands the rule grants, as this machine has them — the Debian paths when they are not here yet. */
export interface SudoPaths {
  apt: string;
  service: string;
  systemctl: string;
  createuser: string;
}
export const sudoPaths = (): SudoPaths => ({
  apt: which('apt-get') ?? '/usr/bin/apt-get',
  service: which('service') ?? '/usr/sbin/service',
  systemctl: which('systemctl') ?? '/usr/bin/systemctl',
  createuser: which('createuser') ?? '/usr/bin/createuser',
});

/**
 * `/etc/sudoers.d/sloth`: install packages, start their services, and become `postgres` for the one
 * command that makes the Sloth user a database superuser. Scoped by absolute path on purpose — a
 * blanket `NOPASSWD: ALL` would hand every session on this machine the whole box.
 */
export function sudoersRule(user: string, paths: SudoPaths = sudoPaths()): string {
  if (!USER.test(user)) throw new Error(`${user} is not a user name Sloth will write into sudoers`);
  return [
    "# Written by Sloth so it can install the project's stack without a password.",
    `${user} ALL=(root) NOPASSWD: ${paths.apt}, ${paths.service}, ${paths.systemctl}`,
    `${user} ALL=(postgres) NOPASSWD: ${paths.createuser}`,
    '',
  ].join('\n');
}

/** The user Sloth runs as — the one the rule is written for. */
export const sudoUser = (): string => os.userInfo().username;

/**
 * One `sudo` run with the password on stdin. `-S` reads it there, `-k` throws away any cached
 * credential so a wrong password fails instead of riding on someone else's `sudo` from a minute ago,
 * `-p ''` keeps the prompt out of stderr. Only the last line of stderr comes back: sudo never echoes
 * what it read, but the less of a child's output crosses this boundary the better.
 */
async function sudoWith(password: string, args: string[]): Promise<{ ok: boolean; err: string }> {
  const bin = which('sudo');
  if (!bin) return { ok: false, err: 'sudo is not installed on this machine' };
  const r = await run(bin, ['-S', '-k', '-p', '', ...args], { timeout: 15_000, stdin: `${password}\n` });
  return { ok: r.ok, err: r.err.split('\n').at(-1)?.trim() ?? '' };
}

/** The same without a password: what the rule bought, and the probe `installer()` uses. */
async function sudoNo(args: string[]): Promise<boolean> {
  const bin = which('sudo');
  return !!bin && (await run(bin, ['-n', ...args], { timeout: 15_000 })).ok;
}

/** Whether `sudo -n` may already run apt-get here — true for a full NOPASSWD line and for Sloth's own rule. */
export const canSudoApt = (): Promise<boolean> => sudoNo(['-l', sudoPaths().apt]);

/**
 * Writes the rule, checking the file both before it goes live and once it is there. Every step spends
 * the password again rather than `sudo -n`: the rule deliberately grants neither `visudo` nor `rm`, so
 * `-n` would fail on exactly the machines this is for. Returns the reason it did not work, or nothing.
 */
export async function unlockSudo(password: string, user = sudoUser()): Promise<string | undefined> {
  if (typeof password !== 'string' || !password) return 'a password is needed';
  if (isDry()) {
    log(`dry-run: would write ${SUDOERS} for ${user}`);
    return undefined;
  }
  if (!(await sudoWith(password, ['true'])).ok) return 'wrong password';
  let rule: string;
  try {
    rule = sudoersRule(user);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  // 0600 in a 0700 directory: between here and `install` the file is readable by nobody else, and it
  // carries no secret anyway — the password never reaches a disk.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sloth-sudoers-'));
  const tmp = path.join(dir, 'sloth');
  try {
    fs.writeFileSync(tmp, rule, { mode: 0o600 });
    const syntax = await sudoWith(password, [which('visudo') ?? '/usr/sbin/visudo', '-cf', tmp]);
    if (!syntax.ok) return `the sudoers rule Sloth wrote is not valid — ${syntax.err || 'visudo refused it'}`;
    const put = await sudoWith(password, [which('install') ?? '/usr/bin/install', '-m', '0440', '-o', 'root', '-g', 'root', tmp, SUDOERS]);
    if (!put.ok) return `could not write ${SUDOERS} — ${put.err || 'sudo refused'}`;
    const live = await sudoWith(password, [which('visudo') ?? '/usr/sbin/visudo', '-cf', SUDOERS]);
    if (!live.ok) {
      await sudoWith(password, ['rm', '-f', SUDOERS]);
      return `${SUDOERS} did not pass visudo and was removed — ${live.err || 'visudo refused it'}`;
    }
    if (!(await canSudoApt())) return `${SUDOERS} was written but sudo still asks for a password`;
    log(`stack: ${SUDOERS} written — apt-get, service, systemctl and createuser now run without a password`);
    return undefined;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
