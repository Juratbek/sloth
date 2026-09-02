import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { broadcast } from './events';
import { log } from './runner/log';
import type { InstallStatus } from './types';

/**
 * Installing tools on the machine Sloth runs on — the tunnel tool from the remote-access dialog, the
 * project's stack (`stack.ts`) from the wizard or at start-up. One job at a time; a job is a few
 * commands run in order, their output tailed for the UI.
 */

// A process started from a GUI may not have Homebrew's bin on PATH; look there regardless. Keg-only
// formulas (postgresql@17, openjdk) live under opt/ even once linked.
export const EXTRA_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/opt/homebrew/opt/postgresql@17/bin', '/usr/local/opt/postgresql@17/bin', '/opt/homebrew/opt/openjdk/bin', '/usr/local/opt/openjdk/bin'];
const FORMULAS: Record<string, string> = { cloudflared: 'cloudflared' };
const TAIL = 30;

/** Absolute path of an executable, or undefined when it is nowhere to be found. */
export function which(cmd: string): string | undefined {
  if (cmd.includes('/')) return fs.existsSync(cmd) ? cmd : undefined;
  // Windows executables carry an extension (PATHEXT); `cmd` arrives without one.
  const exts = process.platform === 'win32' ? ['', ...(process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')] : [''];
  // An empty PATH entry — a trailing colon, which is common — means the cwd to a shell. Here it would
  // make `path.join('', cmd)` a bare name that resolves against Sloth's own checkout, so a file called
  // `git`, `install` or `sudo` committed to the project would be run as that tool, `sudo.ts` included.
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of [...dirs, ...EXTRA_DIRS]) {
    for (const ext of exts) {
      const file = path.join(dir, cmd + ext);
      try {
        fs.accessSync(file, fs.constants.X_OK);
        return file;
      } catch {
        /* not here */
      }
    }
  }
  return undefined;
}

/** Whether Sloth knows how to install `cmd` here: a Homebrew formula for it and brew on the machine. */
export const installable = (cmd: string) => !!FORMULAS[cmd] && !!which('brew');

/** One command of a job. `optional`: a failure is logged and the job carries on. */
export interface Step {
  cmd: string;
  args: string[];
  optional?: boolean;
}
export interface Job {
  /** What the UI says is being installed. */
  label: string;
  steps: Step[];
}

const ENV = {
  HOMEBREW_NO_AUTO_UPDATE: '1',
  HOMEBREW_NO_ENV_HINTS: '1',
  NONINTERACTIVE: '1',
  DEBIAN_FRONTEND: 'noninteractive',
};

let running = false;
let what: string | undefined;
let lines: string[] = [];
let error: string | undefined;

export const installStatus = (): InstallStatus => ({ running, what, output: lines.join('\n'), error });
export const installRunning = () => running;

/** Runs the job's steps one after the other; `done` runs once every step succeeded. False when a job is already running. */
export function runJob(job: Job, done: () => void): boolean {
  if (running || !job.steps.length) return false;
  running = true;
  what = job.label;
  lines = [];
  error = undefined;
  log(`install: ${job.label}`);
  const finish = (failure?: string) => {
    if (!running) return;
    running = false;
    error = failure;
    log(failure ? `install: ${job.label} failed — ${failure}` : `install: ${job.label} done`);
    broadcast();
    if (!failure) done();
  };
  const tail = (chunk: Buffer) => {
    lines = [...lines, ...chunk.toString().split('\n').filter((l) => l.trim())].slice(-TAIL);
    broadcast();
  };
  const next = (i: number) => {
    const step = job.steps[i];
    if (!step) return finish();
    const bin = which(step.cmd);
    if (!bin) return finish(`${step.cmd} is not installed`);
    lines = [...lines, `$ ${step.cmd} ${step.args.join(' ')}`].slice(-TAIL);
    broadcast();
    const proc = spawn(bin, step.args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...ENV } });
    proc.stdout?.on('data', tail);
    proc.stderr?.on('data', tail);
    proc.on('error', (e) => (step.optional ? next(i + 1) : finish(e.message)));
    proc.on('exit', (code) => {
      if (!code) return next(i + 1);
      if (step.optional) {
        log(`install: ${step.cmd} ${step.args.join(' ')} exited with ${code} — ignored`);
        return next(i + 1);
      }
      finish(`${step.cmd} exited with ${code}`);
    });
  };
  next(0);
  return true;
}

/** Installs a Homebrew formula (the tunnel tool); `done` runs when it succeeds. False when it cannot start. */
export function install(cmd: string, done: () => void): boolean {
  if (!installable(cmd)) return false;
  return runJob({ label: cmd, steps: [{ cmd: 'brew', args: ['install', FORMULAS[cmd]] }] }, done);
}
