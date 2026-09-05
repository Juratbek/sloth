import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { STACK, type StackId } from './config-types';
import { run } from './exec';
import { which } from './install';
import { isDry, log } from './runner/log';
import { TOOLS } from './stack-detect';

/**
 * The one place a sudo password is ever touched. A Sloth on a Linux box runs as an ordinary user, so
 * `apt-get` is out of reach and the stack never gets installed. The Stack page asks for that user's
 * password **once**: it is used here, in this process, for the few seconds it takes to write
 * `/etc/sudoers.d/sloth` — the exact command lines installing the stack needs, nothing else — and is
 * then gone. It is never stored, never logged, never put in the environment and never handed to a session:
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

/**
 * Where a program the rule names may live, and nowhere else. The process's PATH is not consulted: a
 * session runs as the same user and could put a `service` of its own in `~/.local/bin`, and a rule that
 * named that file by its absolute path would run it as root the moment the rule was written. A system
 * directory, a regular file owned by root that nobody else can write, and a path with no character
 * sudoers reads as syntax — or the Debian default, which the rule then grants for the day it is installed.
 */
const SYSTEM_DIRS = ['/usr/sbin', '/usr/bin', '/sbin', '/bin'];
const SAFE_PATH = /^\/[A-Za-z0-9._/+@-]+$/;
export function systemBinary(name: string, fallback: string, dirs: string[] = SYSTEM_DIRS): string {
  for (const dir of dirs) {
    const file = path.join(dir, name);
    if (!SAFE_PATH.test(file)) continue;
    try {
      const st = fs.statSync(file);
      if (st.isFile() && st.uid === 0 && (st.mode & 0o022) === 0) return file;
    } catch {
      /* not here */
    }
  }
  if (!SAFE_PATH.test(fallback)) throw new Error(`${fallback} is not a path Sloth will write into sudoers`);
  return fallback;
}
export const sudoPaths = (dirs: string[] = SYSTEM_DIRS): SudoPaths => ({
  apt: systemBinary('apt-get', '/usr/bin/apt-get', dirs),
  service: systemBinary('service', '/usr/sbin/service', dirs),
  systemctl: systemBinary('systemctl', '/usr/bin/systemctl', dirs),
  createuser: systemBinary('createuser', '/usr/bin/createuser', dirs),
});

/**
 * The command lines the rule grants, argument for argument. sudoers matches a command's arguments
 * exactly when a rule names them, and that exactness is the whole defence: a rule that named `apt-get`
 * alone would let `apt-get -o APT::Update::Pre-Invoke=<anything> update` run that anything as root, and
 * `systemctl link` would install any service file — the box, for the price of one line in an issue that
 * a session reads. So the rule is not "these programs" but "these lines": update, install this tool's
 * packages, start this tool's service, make this user a database superuser. `installSteps` (`stack.ts`)
 * runs the very same arrays, and the stack session is told to run them verbatim; anything else `sudo -n`
 * refuses, whatever a session was talked into. Every tool's line is granted, not only the configured
 * stack's: the rule is written once, and a stack that grows later would otherwise need the password again.
 */
export const APT_UPDATE = ['apt-get', 'update', '-q'];
export const aptInstall = (id: StackId): string[] => ['apt-get', 'install', '-y', '-q', ...TOOLS[id].apt.packages];
export const serviceControl = (service: string): string[][] => [
  ['service', service, 'start'],
  ['systemctl', 'start', service],
];
/** Run as `postgres`, not root: the one command that needs to be someone in particular. */
export const createUser = (user: string): string[] => ['createuser', '-s', user];

/** What may stand in one argument of the rule: a package, a service, a flag. Never a sudoers metacharacter. */
const ARG = /^[A-Za-z0-9._+@-]+$/;

/** Every root command line the rule grants, as argv arrays without the program's path. */
export function grantedLines(): string[][] {
  const lines: string[][] = [APT_UPDATE];
  for (const id of STACK) {
    lines.push(aptInstall(id));
    const service = TOOLS[id].apt.service;
    if (service) lines.push(...serviceControl(service));
  }
  return lines;
}

const PROGRAM: Record<string, keyof SudoPaths> = { 'apt-get': 'apt', service: 'service', systemctl: 'systemctl', createuser: 'createuser' };

/** One entry of a sudoers command list: the program by absolute path, then its arguments. */
function entry(paths: SudoPaths, argv: string[]): string {
  const [program, ...args] = argv;
  const key = PROGRAM[program];
  if (!key) throw new Error(`${program} is not a program Sloth will write into sudoers`);
  for (const a of args) if (!ARG.test(a)) throw new Error(`${a} is not an argument Sloth will write into sudoers`);
  return [paths[key], ...args].join(' ');
}

/**
 * `/etc/sudoers.d/sloth`: the granted lines, one per command, each with its arguments spelled out. The
 * program is scoped by absolute path and the arguments by their exact text — a blanket `NOPASSWD: ALL`,
 * or a program with its arguments left open, would hand every session on this machine the whole box.
 * No environment variable crosses either: a name sudoers could let through, its value it could not, and
 * a value the session chooses would land in a root `apt-get`. `-y -q` and no terminal are enough for
 * debconf to answer its own questions.
 */
export function sudoersRule(user: string, paths: SudoPaths = sudoPaths()): string {
  if (!USER.test(user)) throw new Error(`${user} is not a user name Sloth will write into sudoers`);
  const root = grantedLines().map((argv) => entry(paths, argv));
  return [
    "# Written by Sloth so it can install the project's stack without a password: these exact command lines, nothing else.",
    `${user} ALL=(root) NOPASSWD: ${root.join(', \\\n    ')}`,
    `${user} ALL=(postgres) NOPASSWD: ${entry(paths, createUser(user))}`,
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
  if (!which('sudo')) return { ok: false, err: 'sudo is not installed on this machine' };
  const r = await run(systemBinary('sudo', '/usr/bin/sudo'), ['-S', '-k', '-p', '', ...args], { timeout: 15_000, stdin: `${password}\n` });
  return { ok: r.ok, err: r.err.split('\n').at(-1)?.trim() ?? '' };
}

/** The same without a password: what the rule bought, and the probe `installer()` uses. */
async function sudoNo(args: string[]): Promise<boolean> {
  return !!which('sudo') && (await run(systemBinary('sudo', '/usr/bin/sudo'), ['-n', ...args], { timeout: 15_000 })).ok;
}

/**
 * Whether `sudo -n` may already run `apt-get update -q` here — true for a full NOPASSWD line and for
 * Sloth's own rule. Asked with the arguments: a rule that names them answers only to the whole line.
 */
export const canSudoApt = (): Promise<boolean> => sudoNo(['-l', sudoPaths().apt, ...APT_UPDATE.slice(1)]);

/**
 * Whether sudo lets this user run `apt-get` with an argument Sloth never grants — then the rule in force
 * is wider than Sloth's: the one an older Sloth wrote, which named the programs and left their arguments
 * open, or a blanket line of the machine's own. The file cannot be read (0440 root), so sudo is asked.
 */
export const sudoWide = (): Promise<boolean> => sudoNo(['-l', sudoPaths().apt, 'update', '--sloth-never-grants-this']);

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
    const visudo = systemBinary('visudo', '/usr/sbin/visudo');
    const syntax = await sudoWith(password, [visudo, '-cf', tmp]);
    if (!syntax.ok) return `the sudoers rule Sloth wrote is not valid — ${syntax.err || 'visudo refused it'}`;
    const put = await sudoWith(password, [systemBinary('install', '/usr/bin/install'), '-m', '0440', '-o', 'root', '-g', 'root', tmp, SUDOERS]);
    if (!put.ok) return `could not write ${SUDOERS} — ${put.err || 'sudo refused'}`;
    const live = await sudoWith(password, [visudo, '-cf', SUDOERS]);
    if (!live.ok) {
      await sudoWith(password, ['rm', '-f', SUDOERS]);
      return `${SUDOERS} did not pass visudo and was removed — ${live.err || 'visudo refused it'}`;
    }
    if (!(await canSudoApt())) return `${SUDOERS} was written but sudo still asks for a password`;
    log(`stack: ${SUDOERS} written — ${grantedLines().length + 1} exact command lines (apt-get update and install, service start, createuser) now run without a password`);
    // Sloth's own file is replaced by the write above; a wide line that survives it is the machine's own.
    if (await sudoWide()) log(`stack: sudo still lets ${user} run apt-get with any arguments — a rule Sloth did not write; ${SUDOERS} is the narrow one`);
    return undefined;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
