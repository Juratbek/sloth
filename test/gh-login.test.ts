import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `gh auth login --web` is a process that prints a code, waits, and exits: the fake here is a child
 * whose output and exit the test writes. What follows a login — the credential helper and the health
 * reading — is watched, not run.
 */
const h = vi.hoisted(() => ({
  children: [] as { args: string[]; options: Record<string, any>; kill: () => void; killed: boolean; emit: (e: string, ...v: unknown[]) => boolean; stdout: any; stderr: any }[],
  ran: [] as string[],
  health: 0,
  ghBin: '/usr/local/bin/gh' as string | undefined,
  /** When set, `spawn` throws it on the spot — what Node does for a `.cmd` shim without a shell. */
  spawnThrows: '' as string,
}));

vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    spawn: (_cmd: string, args: string[], options: Record<string, any>) => {
      if (h.spawnThrows) throw new Error(h.spawnThrows);
      const child = Object.assign(new EventEmitter(), {
        args,
        options,
        killed: false,
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill() {
          child.killed = true;
        },
      });
      h.children.push(child);
      return child;
    },
    execFile: (cmd: string, args: string[], _o: unknown, cb: (e: Error | null, out: string, err: string) => void) => {
      h.ran.push([cmd, ...args].join(' '));
      cb(null, '', '');
      return { on() {}, kill() {}, stdin: { end() {} } };
    },
  };
});
vi.mock('../server/install', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/install')>()),
  which: () => h.ghBin,
}));
vi.mock('../server/health', () => ({
  refreshHealth: async () => {
    h.health += 1;
    return { at: 0, checks: [] };
  },
}));

import { cancelGhLogin, ghLoginStatus, parseDeviceFlow, startGhLogin, stopGhLogin } from '../server/gh-login';
import { handleSetup } from '../server/setup';
import { configure, wipe } from './harness';

const PROMPT = '! First copy your one-time code: 1A2B-3C4D\nOpen this URL to continue in your web browser: https://github.com/login/device\n';
const say = (text: string, child = h.children.at(-1)!) => child.stderr.emit('data', Buffer.from(text));
/** The child is reaped and its pipes drained — `exit`, then `close` — with the code, or the signal it died of. */
const exit = async (code: number | null, signal: string | null = null, child = h.children.at(-1)!) => {
  child.emit('exit', code, signal);
  child.emit('close', code, signal);
  await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  configure();
  wipe();
  cancelGhLogin();
  h.children.length = 0;
  h.ran.length = 0;
  h.health = 0;
  h.ghBin = '/usr/local/bin/gh';
  h.spawnThrows = '';
});
afterEach(() => cancelGhLogin());

describe('the wizard’s gh login', () => {
  it('runs the web device flow without a terminal, and shows the code gh prints', () => {
    expect(startGhLogin()).toEqual({ running: true });
    const child = h.children[0];
    expect(child.args).toEqual(['auth', 'login', '--web', '--hostname', 'github.com', '--git-protocol', 'https', '--skip-ssh-key']);
    expect(child.options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    expect(child.options.env.GH_PROMPT_DISABLED).toBe('1');
    say(PROMPT);
    expect(ghLoginStatus()).toEqual({ running: true, code: '1A2B-3C4D', url: 'https://github.com/login/device' });
  });

  it('reads the code however gh splits its lines across chunks', () => {
    startGhLogin();
    say('! First copy your one-time ');
    expect(ghLoginStatus().code).toBeUndefined();
    say('code: 1A2B-3C4D\n');
    expect(ghLoginStatus()).toMatchObject({ code: '1A2B-3C4D', url: 'https://github.com/login/device' });
    expect(parseDeviceFlow('nothing yet')).toEqual({});
  });

  it('sets up the git credential helper and retakes the health reading once gh reports the login', async () => {
    startGhLogin();
    say(PROMPT);
    await exit(0);
    expect(ghLoginStatus()).toEqual({ running: false, ok: true });
    expect(h.ran).toEqual(['/usr/local/bin/gh auth setup-git --hostname github.com']);
    expect(h.health).toBe(1);
  });

  it('keeps gh’s own reason when the login fails, not the code it printed', async () => {
    startGhLogin();
    say(PROMPT);
    say('error: The device code has expired\n');
    await exit(1);
    expect(ghLoginStatus()).toEqual({ running: false, error: 'error: The device code has expired' });
    expect(h.ran).toEqual([]);
    expect(h.health).toBe(0);
  });

  it('reads the reason still in the pipe when gh is reaped before its last line is delivered', async () => {
    startGhLogin();
    say(PROMPT);
    const child = h.children[0];
    child.emit('exit', 1, null);
    say('error: authentication timed out\n');
    expect(ghLoginStatus().running).toBe(true);
    child.emit('close', 1, null);
    expect(ghLoginStatus()).toEqual({ running: false, error: 'error: authentication timed out' });
  });

  it('does not take a gh killed by a signal for a login', async () => {
    startGhLogin();
    say(PROMPT);
    await exit(null, 'SIGTERM');
    expect(ghLoginStatus()).toEqual({ running: false, error: 'gh was stopped by SIGTERM' });
    expect(h.ran).toEqual([]);
    expect(h.health).toBe(0);
  });

  it('runs one login at a time — a second press joins the first', () => {
    startGhLogin();
    say(PROMPT);
    expect(startGhLogin().code).toBe('1A2B-3C4D');
    expect(h.children).toHaveLength(1);
  });

  it('cancels the one waiting, and its late exit says nothing', async () => {
    startGhLogin();
    expect(cancelGhLogin()).toEqual({ running: false });
    expect(h.children[0].killed).toBe(true);
    await exit(1);
    expect(ghLoginStatus()).toEqual({ running: false });
  });

  it('keeps a cancelled login’s late output away from the one started after it', async () => {
    startGhLogin();
    const first = h.children[0];
    cancelGhLogin();
    startGhLogin();
    say(PROMPT, first);
    expect(ghLoginStatus()).toEqual({ running: true });
    await exit(1, null, first);
    expect(ghLoginStatus()).toEqual({ running: true });
    say(PROMPT.replace('1A2B-3C4D', 'WXYZ-9876'));
    expect(ghLoginStatus().code).toBe('WXYZ-9876');
  });

  it('is left startable again when spawn itself throws', () => {
    h.spawnThrows = 'spawn EINVAL';
    expect(startGhLogin()).toEqual({ running: false, error: 'spawn EINVAL' });
    expect(cancelGhLogin()).toEqual({ running: false });
    h.spawnThrows = '';
    expect(startGhLogin()).toEqual({ running: true });
    expect(h.children).toHaveLength(1);
  });

  it('goes down with the server, so no gh keeps polling for a code nobody sees', () => {
    stopGhLogin();
    startGhLogin();
    stopGhLogin();
    expect(h.children[0].killed).toBe(true);
    expect(ghLoginStatus()).toEqual({ running: false });
  });

  it('says so when gh is not installed instead of starting nothing', () => {
    h.ghBin = undefined;
    expect(startGhLogin()).toEqual({ running: false, error: '`gh` was not found on PATH' });
    expect(h.children).toHaveLength(0);
  });

  it('is reached through /api/setup/gh-login: POST starts, GET reads, POST …/cancel stops', async () => {
    expect(await handleSetup('/api/setup/gh-login', 'GET', undefined)).toEqual({ running: false });
    expect(h.children).toHaveLength(0);
    expect(await handleSetup('/api/setup/gh-login', 'POST', {})).toEqual({ running: true });
    expect(h.children).toHaveLength(1);
    say(PROMPT);
    expect(await handleSetup('/api/setup/gh-login', 'GET', undefined)).toMatchObject({ running: true, code: '1A2B-3C4D' });
    expect(await handleSetup('/api/setup/gh-login/cancel', 'POST', {})).toEqual({ running: false });
    expect(await handleSetup('/api/setup/gh-login/cancel', 'GET', undefined)).toBeUndefined();
  });
});
