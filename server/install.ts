import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { broadcast } from './events';
import { log } from './runner/log';
import type { InstallStatus } from './types';

/** Installing the tunnel tool from the UI — `brew install cloudflared`, one run at a time. */

// A process started from a GUI may not have Homebrew's bin on PATH; look there regardless.
const EXTRA_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'];
const FORMULAS: Record<string, string> = { cloudflared: 'cloudflared' };
const TAIL = 30;

/** Absolute path of an executable, or undefined when it is nowhere to be found. */
export function which(cmd: string): string | undefined {
  if (cmd.includes('/')) return fs.existsSync(cmd) ? cmd : undefined;
  for (const dir of [...(process.env.PATH ?? '').split(path.delimiter), ...EXTRA_DIRS]) {
    const file = path.join(dir, cmd);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return file;
    } catch {
      /* not here */
    }
  }
  return undefined;
}

/** Whether Sloth knows how to install `cmd` here: a Homebrew formula for it and brew on the machine. */
export const installable = (cmd: string) => !!FORMULAS[cmd] && !!which('brew');

let running = false;
let lines: string[] = [];
let error: string | undefined;

export const installStatus = (): InstallStatus => ({ running, output: lines.join('\n'), error });

/** Starts the install; `done` runs when it succeeds. False when it cannot start (or one is already running). */
export function install(cmd: string, done: () => void): boolean {
  const brew = which('brew');
  if (!installable(cmd) || !brew || running) return false;
  running = true;
  lines = [];
  error = undefined;
  log(`remote: installing ${cmd} with Homebrew`);
  const finish = (failure?: string) => {
    if (!running) return;
    running = false;
    error = failure;
    log(failure ? `remote: install failed — ${failure}` : `remote: ${cmd} installed`);
    broadcast();
    if (!failure) done();
  };
  const proc = spawn(brew, ['install', FORMULAS[cmd]], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_ENV_HINTS: '1', NONINTERACTIVE: '1' },
  });
  const tail = (chunk: Buffer) => {
    lines = [...lines, ...chunk.toString().split('\n').filter((l) => l.trim())].slice(-TAIL);
    broadcast();
  };
  proc.stdout?.on('data', tail);
  proc.stderr?.on('data', tail);
  proc.on('error', (e) => finish(e.message));
  proc.on('exit', (code) => finish(code ? `brew exited with ${code}` : undefined));
  return true;
}
