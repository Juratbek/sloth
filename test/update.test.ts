import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configure, readLog, root, wipe } from './harness';

/**
 * `server/update.ts` shells out for everything, so the git it reads and the processes it starts are
 * both fakes here. Its state — the last reading, the update in flight — is module-level, so every test
 * takes a fresh copy of the module.
 */
const h = vi.hoisted(() => ({
  /** `git` stdout by argv pattern, first match wins. */
  git: [] as { match: RegExp; out: string }[],
  ran: [] as string[],
  spawns: [] as { cmd: string; args: string[]; options?: Record<string, unknown> }[],
  /** What every step's process exits with. */
  stepExit: 0,
  /** When set, every spawn fails the way a missing program does, instead of starting. */
  spawnError: '' as string,
  /** Where `which` finds a tool; anything not listed is its bare name. */
  bin: {} as Record<string, string>,
}));

vi.mock('node:child_process', () => ({
  execFile: (cmd: string, args: string[], _o: unknown, cb: (e: Error | null, out: string, err: string) => void) => {
    const line = [cmd, ...args].join(' ');
    h.ran.push(line);
    cb(null, h.git.find((g) => g.match.test(line))?.out ?? '', '');
    return { on() {}, kill() {} };
  },
  spawn: (cmd: string, args: string[], options: Record<string, unknown>) => {
    h.spawns.push({ cmd, args, options });
    const handlers: Record<string, (v: unknown) => void> = {};
    queueMicrotask(() => {
      if (h.spawnError) return handlers.error?.(new Error(h.spawnError));
      handlers.spawn?.(undefined);
      handlers.exit?.(h.stepExit);
    });
    return {
      pid: 1,
      unref() {},
      on(event: string, fn: (v: unknown) => void) {
        handlers[event] = fn;
      },
      stdout: { on() {} },
      stderr: { on() {} },
    };
  },
}));

// Every tool the update needs is on PATH; which one is irrelevant to what is under test.
vi.mock('../server/install', () => ({ EXTRA_DIRS: [], which: (cmd: string) => h.bin[cmd] ?? cmd }));

const HEAD = { match: /log -1/, out: 'abc1234\n2026-09-01T10:00:00Z' };
const BRANCH = { match: /rev-parse --abbrev-ref/, out: 'main' };
const CLEAN = { match: /status --porcelain/, out: '' };
const DIRTY = { match: /status --porcelain/, out: ' M server/api.ts' };
const behind = (n: number) => ({ match: /rev-list --count HEAD\.\./, out: String(n) });

/** A fresh `update.ts`, with no reading and no update left over from the test before. */
async function freshUpdate() {
  vi.resetModules();
  return import('../server/update');
}

const plist = () => path.join(root(), 'Library/LaunchAgents/dev.sloth.widgets.plist');

beforeEach(() => {
  configure({ autoUpdate: true, updateSeconds: 300 });
  wipe();
  h.git = [HEAD, BRANCH, CLEAN, behind(0)];
  h.ran = [];
  h.spawns = [];
  h.stepExit = 0;
  fs.rmSync(path.dirname(plist()), { recursive: true, force: true });
  // `restart` exits the process half a second after it is asked to; no test wants that to arrive.
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

const steps = () => h.spawns.map((s) => [s.cmd, ...s.args].join(' '));

describe('autoUpdate', () => {
  it('pulls, installs, builds and restarts when the checkout is behind', async () => {
    h.git = [HEAD, BRANCH, CLEAN, behind(3)];
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const { autoUpdate, versionInfo } = await freshUpdate();
    await autoUpdate();
    expect(steps().slice(0, 3)).toEqual(['git pull --ff-only origin main', 'pnpm install', 'pnpm build']);
    // The fourth is the restart, which is `restart`'s own test.
    expect(h.spawns[3]?.cmd).toBe(process.execPath);
    expect((await versionInfo()).update.restarting).toBe(true);
    exit.mockRestore();
    expect(readLog().join('\n')).toMatch(/auto-update: 3 commits behind origin\/main — updating/);
  });

  it('does nothing at all while the setting is off', async () => {
    configure({ autoUpdate: false });
    h.git = [HEAD, BRANCH, CLEAN, behind(3)];
    const { autoUpdate } = await freshUpdate();
    await autoUpdate();
    // Not even the fetch: an unwanted update does not spend a network call an hour either.
    expect(h.ran).toEqual([]);
    expect(steps()).toEqual([]);
  });

  it('looks but installs nothing when the checkout is already up to date', async () => {
    const { autoUpdate } = await freshUpdate();
    await autoUpdate();
    expect(h.ran.some((l) => l.includes('fetch'))).toBe(true);
    expect(steps()).toEqual([]);
  });

  it('leaves a checkout with local changes alone, and says so once', async () => {
    h.git = [HEAD, BRANCH, DIRTY, behind(2)];
    const { autoUpdate } = await freshUpdate();
    await autoUpdate();
    await autoUpdate();
    expect(steps()).toEqual([]);
    const said = readLog().filter((l) => /local changes/.test(l));
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/2 commits behind, but the checkout has local changes/);
  });

  it('stops at a failed step, leaving the process alive to try again later', async () => {
    h.git = [HEAD, BRANCH, CLEAN, behind(1)];
    h.stepExit = 1;
    const { autoUpdate, versionInfo } = await freshUpdate();
    await autoUpdate();
    const v = await versionInfo();
    expect(v.update.restarting).toBe(false);
    expect(v.update.error).toMatch(/git exited with 1/);
    expect(steps()).toEqual(['git pull --ff-only origin main']);
  });
});

describe('restart', () => {
  let exit: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.useFakeTimers();
    exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });
  afterEach(() => {
    exit.mockRestore();
    vi.useRealTimers();
    h.spawnError = '';
  });

  it('starts a replacement through Node itself — the same command line, on every platform — and exits once it is up', async () => {
    const { restart } = await freshUpdate();
    restart();
    const last = h.spawns.at(-1);
    expect(last?.cmd).toBe(process.execPath);
    expect(last?.args.slice(0, 2)).toEqual(['-e', expect.stringContaining('spawn(process.argv[1], process.argv.slice(2)')]);
    expect(last?.args.slice(2)).toEqual([process.execPath, ...process.argv.slice(1)]);
    expect(last?.cmd).not.toBe('/bin/sh');
    expect(readLog().at(-1)).toMatch(/update: restarting Sloth/);
    await vi.advanceTimersByTimeAsync(600);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('stays up when the replacement cannot be started, and says so', async () => {
    h.spawnError = 'spawn ENOENT';
    const { restart, versionInfo } = await freshUpdate();
    restart();
    await vi.advanceTimersByTimeAsync(600);
    expect(exit).not.toHaveBeenCalled();
    const v = await versionInfo();
    expect(v.update.restarting).toBe(false);
    // …and is not wedged: the next update, by hand or by the hour, may run.
    expect(v.update.running).toBe(false);
    expect(v.update.error).toMatch(/replacement process could not be started — spawn ENOENT; Sloth stays up/);
    expect(readLog().at(-1)).toMatch(/Sloth stays up/);
  });

  it('runs a Windows pnpm.cmd through a shell, quoted, with the same fixed arguments', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    h.bin = { pnpm: 'C:\\Program Files\\nodejs\\pnpm.cmd' };
    h.git = [HEAD, BRANCH, CLEAN, behind(1)];
    try {
      const { autoUpdate } = await freshUpdate();
      await autoUpdate();
      const install = h.spawns[1];
      expect(install.cmd).toBe('"C:\\Program Files\\nodejs\\pnpm.cmd"');
      expect(install.args).toEqual(['install']);
      expect(install.options).toMatchObject({ shell: true, windowsHide: true });
      expect(h.spawns[0]).toMatchObject({ cmd: 'git' });
      expect(h.spawns[0].options).not.toHaveProperty('shell');
    } finally {
      Object.defineProperty(process, 'platform', platform);
      h.bin = {};
    }
  });

  it('only exits when the launch agent is installed — launchd starts the next Sloth, so two never run', async () => {
    fs.mkdirSync(path.dirname(plist()), { recursive: true });
    fs.writeFileSync(plist(), '<plist/>');
    const { restart } = await freshUpdate();
    restart();
    expect(h.spawns).toEqual([]);
    expect(readLog().at(-1)).toMatch(/update: exiting — the launch agent starts Sloth again/);
    await vi.advanceTimersByTimeAsync(600);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
