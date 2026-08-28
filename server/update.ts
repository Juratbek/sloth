import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { SLOTH_ROOT } from './config';
import { broadcast } from './events';
import { which } from './install';
import { log } from './runner/log';
import type { UpdateStatus, VersionInfo } from './types';

/**
 * Sloth's own version and its update: what commit this checkout runs, how far behind `origin/<branch>`
 * it is, and — from the settings page — pull, install, build and restart. The restart re-executes this
 * process with the same argv, cwd and environment, so the new server code loads; the detached sessions
 * are not touched, they only notice the monitor blink.
 */

const TAIL = 40;
const REMOTE = 'origin';

const status: UpdateStatus = { running: false, output: '', restarting: false };
let lines: string[] = [];
let local: Pick<VersionInfo, 'commit' | 'date' | 'branch' | 'dirty'> | undefined;
let behind: number | undefined;
let checkedAt: string | undefined;
let checkError: string | undefined;
let checking: Promise<void> | undefined;

function git(args: string[], timeout = 60_000): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) =>
    execFile(which('git') ?? 'git', args, { cwd: SLOTH_ROOT, timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (e, out, err) =>
      resolve({ ok: !e, out: out.trim(), err: (err || (e ? e.message : '')).trim() }),
    ),
  );
}

function version(): string {
  try {
    return String((JSON.parse(fs.readFileSync(path.join(SLOTH_ROOT, 'package.json'), 'utf8')) as { version?: string }).version ?? '');
  } catch {
    return '';
  }
}

/** The commit, branch and cleanliness of the checkout — read once, again after a check or an update. */
async function readLocal(): Promise<NonNullable<typeof local>> {
  const [head, branch, porcelain] = await Promise.all([
    git(['log', '-1', '--format=%h%n%cI']),
    git(['rev-parse', '--abbrev-ref', 'HEAD']),
    git(['status', '--porcelain', '--untracked-files=no']),
  ]);
  const [commit, date] = head.ok ? head.out.split('\n') : [];
  return { commit, date, branch: branch.ok && branch.out !== 'HEAD' ? branch.out : undefined, dirty: porcelain.ok && porcelain.out.length > 0 };
}

export async function versionInfo(): Promise<VersionInfo> {
  local ??= await readLocal();
  return { version: version(), ...local, behind, checkedAt, checkError, update: { ...status, output: lines.join('\n') } };
}

/** Fetches the remote and counts the commits this checkout is behind. One fetch at a time; callers share it. */
export function check(): Promise<void> {
  checking ??= (async () => {
    local = await readLocal();
    const branch = local.branch ?? 'main';
    const fetch = await git(['fetch', '-q', REMOTE, branch], 120_000);
    if (!fetch.ok) {
      checkError = fetch.err.split('\n')[0] || 'git fetch failed';
      behind = undefined;
    } else {
      const count = await git(['rev-list', '--count', `HEAD..${REMOTE}/${branch}`]);
      behind = count.ok ? Number(count.out) || 0 : undefined;
      checkError = count.ok ? undefined : count.err.split('\n')[0];
    }
    checkedAt = new Date().toISOString();
    checking = undefined;
    broadcast();
  })();
  return checking;
}

/** Runs one step of the update, streaming its output into the tail. Resolves to an error message, or nothing. */
function step(name: UpdateStatus['step'], cmd: string, args: string[]): Promise<string | undefined> {
  status.step = name;
  lines = [...lines, `$ ${[cmd, ...args].join(' ')}`].slice(-TAIL);
  broadcast();
  return new Promise((resolve) => {
    const bin = which(cmd);
    if (!bin) return resolve(`${cmd} is not installed (or not on PATH)`);
    const proc = spawn(bin, args, { cwd: SLOTH_ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0', CI: '1' } });
    const tail = (chunk: Buffer) => {
      lines = [...lines, ...chunk.toString().split('\n').filter((l) => l.trim())].slice(-TAIL);
      broadcast();
    };
    proc.stdout?.on('data', tail);
    proc.stderr?.on('data', tail);
    proc.on('error', (e) => resolve(e.message));
    proc.on('exit', (code) => resolve(code ? `${cmd} exited with ${code}` : undefined));
  });
}

/**
 * Replaces this process with a fresh one: the same command line, cwd and environment, started detached
 * a second after this one exits so the port is free. Whatever wrapped this process (`pnpm start`,
 * `caffeinate`) returns; the sessions, detached themselves, keep running.
 */
export function restart(): void {
  status.restarting = true;
  status.step = 'restart';
  log('update: restarting Sloth');
  broadcast();
  const child = spawn('/bin/sh', ['-c', 'sleep 1; exec "$0" "$@"', process.execPath, ...process.argv.slice(1)], {
    cwd: process.cwd(),
    detached: true,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: process.env,
  });
  child.unref();
  // A moment for the answer and the SSE event to leave; the 'exit' handlers stop the loop and the tunnels.
  setTimeout(() => process.exit(0), 500);
}

/** Pull, install, build, restart — one at a time. False when one is already running. */
export function update(): boolean {
  if (status.running) return false;
  status.running = true;
  status.error = undefined;
  status.step = undefined;
  lines = [];
  log('update: started');
  void (async () => {
    const branch = (local ?? (await readLocal())).branch ?? 'main';
    const failure =
      (await step('pull', 'git', ['pull', '--ff-only', REMOTE, branch])) ??
      (await step('install', 'pnpm', ['install'])) ??
      (await step('build', 'pnpm', ['build']));
    local = await readLocal();
    if (failure) {
      status.running = false;
      status.step = undefined;
      status.error = failure;
      log(`update: failed — ${failure}`);
      broadcast();
      return;
    }
    behind = 0;
    log(`update: now at ${local.commit ?? '?'}`);
    restart();
  })();
  return true;
}
