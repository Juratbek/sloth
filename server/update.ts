import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { SLOTH_ROOT, cfg } from './config';
import { run } from './exec';
import { broadcast } from './events';
import { which } from './install';
import { log } from './runner/log';
import { serviceStatus } from './service';
import type { UpdateStatus, VersionInfo } from './types';

/**
 * Sloth's own version and its update: what commit this checkout runs, how far behind `origin/<branch>`
 * it is, and — from the settings page, or on its own with `autoUpdate` on — pull, install, build and
 * restart. The restart re-executes this process with the same argv, cwd and environment, so the new
 * server code loads; the detached sessions are not touched, they only notice the monitor blink.
 */

const TAIL = 40;
const REMOTE = 'origin';

const status: UpdateStatus = { running: false, output: '', restarting: false };
let lines: string[] = [];
let local: Pick<VersionInfo, 'version' | 'commit' | 'date' | 'branch' | 'dirty'> | undefined;
let behind: number | undefined;
let checkedAt: string | undefined;
let checkError: string | undefined;
let checking: Promise<void> | undefined;

/** `git` in this checkout, never prompting for credentials — the update runs with nobody watching. */
const git = (args: string[], timeout = 60_000) =>
  run(which('git') ?? 'git', args, { cwd: SLOTH_ROOT, timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });

function packageVersion(): string {
  try {
    return String((JSON.parse(fs.readFileSync(path.join(SLOTH_ROOT, 'package.json'), 'utf8')) as { version?: string }).version ?? '');
  } catch {
    return '';
  }
}

/**
 * The version Sloth shows: `major.minor` from package.json, and for the patch the number of PRs merged
 * into the branch — so it goes up with every merge on its own, with no release commit and no CI to
 * make one (GitHub Actions is not a given). PRs land as merge commits, and `--first-parent` counts only
 * the ones on the branch's own line, not merges made inside a feature branch. Without a count (no git,
 * not a clone) the version is package.json's, as it is.
 */
export const versionOf = (pkg: string, merges: number | undefined): string => {
  const [major, minor] = pkg.split('.');
  return merges === undefined || !major || !minor ? pkg : `${major}.${minor}.${merges}`;
};

/** The commit, branch, cleanliness and merge count of the checkout — read once, again after a check or an update. */
async function readLocal(): Promise<NonNullable<typeof local>> {
  const [head, branch, porcelain, merges] = await Promise.all([
    git(['log', '-1', '--format=%h%n%cI']),
    git(['rev-parse', '--abbrev-ref', 'HEAD']),
    git(['status', '--porcelain', '--untracked-files=no']),
    git(['rev-list', '--count', '--first-parent', '--merges', 'HEAD']),
  ]);
  const [commit, date] = head.ok ? head.out.split('\n') : [];
  return {
    version: versionOf(packageVersion(), merges.ok && /^\d+$/.test(merges.out) ? Number(merges.out) : undefined),
    commit,
    date,
    branch: branch.ok && branch.out !== 'HEAD' ? branch.out : undefined,
    dirty: porcelain.ok && porcelain.out.length > 0,
  };
}

export async function versionInfo(): Promise<VersionInfo> {
  local ??= await readLocal();
  return { ...local, behind, checkedAt, checkError, update: { ...status, output: lines.join('\n') } };
}

/** Fetches the remote and counts the commits this checkout is behind. One fetch at a time; callers share it. */
export function check(): Promise<void> {
  checking ??= (async () => {
    try {
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
    } catch (e) {
      // Nothing here may reject: `autoUpdate` runs on the watcher's own chain and the settings page awaits
      // this. And nothing here may keep `checking` set either, or one bad look would freeze every later one.
      checkError = (e instanceof Error ? e.message : String(e)).split('\n')[0];
      behind = undefined;
    } finally {
      checkedAt = new Date().toISOString();
      checking = undefined;
      broadcast();
    }
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
    // `pnpm` on Windows is `pnpm.cmd`, a batch file, which Node runs only through a shell; the arguments
    // here are Sloth's own fixed words (`install`, `build`), never anything read from outside.
    const script = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
    const proc = spawn(script ? `"${bin}"` : bin, args, {
      cwd: SLOTH_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', CI: '1' },
      ...(script ? { shell: true, windowsHide: true } : {}),
    });
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
 *
 * The replacement is started by Node itself (`node -e`, then the real command line a second later) on
 * every platform: it used to go through `/bin/sh`, which Windows does not have — the spawn failed with
 * nobody listening, the exit ran anyway, and the first auto-update on a Windows machine was the last
 * thing that Sloth did. This process exits only once the replacement has in fact been started; a spawn
 * that fails leaves it up, with the new code on disk for a restart by hand, and says so on the page.
 *
 * Unless launchd owns this process. The launch agent is `KeepAlive`, so it starts Sloth again by itself
 * the moment this one goes: spawning a replacement as well would leave two Sloths watching one board,
 * each ticking it independently — duplicate sessions on a card, duplicate comments, duplicate moves.
 * Exiting *is* the restart there. (`strictPort` in `vite.config.ts` is the second line of defence: a
 * second instance fails to bind rather than quietly taking the next port.)
 */
const RELAUNCH = 'setTimeout(() => require("node:child_process").spawn(process.argv[1], process.argv.slice(2), { detached: true, stdio: "inherit", windowsHide: true }).unref(), 1000)';

export function restart(): void {
  status.restarting = true;
  status.step = 'restart';
  const relaunches = serviceStatus().installed;
  log(relaunches ? 'update: exiting — the launch agent starts Sloth again' : 'update: restarting Sloth');
  broadcast();
  // A moment for the answer and the SSE event to leave; the 'exit' handlers stop the loop and the tunnels.
  const exit = () => setTimeout(() => process.exit(0), 500);
  if (relaunches) {
    exit();
    return;
  }
  const child = spawn(process.execPath, ['-e', RELAUNCH, process.execPath, ...process.argv.slice(1)], {
    cwd: process.cwd(),
    detached: true,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: process.env,
    windowsHide: true,
  });
  child.unref();
  child.on('spawn', exit);
  child.on('error', (e) => {
    status.running = false;
    status.restarting = false;
    status.step = undefined;
    status.error = `the replacement process could not be started — ${e.message}; Sloth stays up on the old code until it is restarted by hand`;
    log(`update: ${status.error}`);
    broadcast();
  });
}

async function runUpdate(): Promise<void> {
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
}

let inFlight: Promise<void> | undefined;

/** Pull, install, build, restart — one at a time. False when one is already running. */
export function update(): boolean {
  if (status.running) return false;
  status.running = true;
  status.error = undefined;
  status.step = undefined;
  lines = [];
  log('update: started');
  // Not awaited here: the API answers while this runs, so the settings page can stream the output.
  // `autoUpdate` keeps the promise, because it must not let a tick start before the restart.
  inFlight = runUpdate();
  return true;
}

/** Said once per reason, so an hourly look at a checkout that cannot update does not fill the log. */
let skipped: string | undefined;
const skip = (why: string): void => {
  if (skipped !== why) log(`auto-update: ${why}`);
  skipped = why;
};

/**
 * One look at the remote for `autoUpdate`, and the update when there is one to install. Called by the
 * watcher's own timer, which queues it behind the tick in flight and holds the next tick until it is
 * over — a restart in the middle of moving a card is how a card ends up in two places.
 *
 * A checkout with local changes is left alone: `git pull --ff-only` would refuse, and there is nothing
 * useful to do about that from here. The reason is logged once, not once an hour.
 */
export async function autoUpdate(): Promise<void> {
  if (!cfg().autoUpdate || status.running || status.restarting) return;
  await check();
  if (checkError) return skip(`could not reach ${REMOTE} — ${checkError}`);
  if (!behind) {
    skipped = undefined;
    return;
  }
  if (local?.dirty) return skip(`${behind} commit${behind === 1 ? '' : 's'} behind, but the checkout has local changes — update it by hand`);
  skipped = undefined;
  log(`auto-update: ${behind} commit${behind === 1 ? '' : 's'} behind ${REMOTE}/${local?.branch ?? 'main'} — updating`);
  if (update()) await inFlight;
}
