import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { startStackSession, withStackSession } from '../server/stack-session';
import { setDry } from '../server/runner/log';
import type { InstallStatus } from '../server/types';
import { FAKE_PID, resetSpawn, spawned } from './child-process-mock';
import { resetGh } from './gh-mock';
import { alivePid, configure, exists, read, readLog, root, wipe } from './harness';

vi.mock('../server/runner/gh', () => import('./gh-mock'));
vi.mock('node:child_process', () => import('./child-process-mock'));

/**
 * The AI session that installs the stack on the machine Sloth runs on. It lives in one directory,
 * `<sessionsDir>/stack`, which `runDirs` does not recognise as a run — so it takes no session slot and
 * never shows up on the board.
 */

const dir = () => path.join(root(), 'sessions', 'stack');

/** The directory as a previous or a live install session left it. */
function left(files: Record<string, string>): void {
  fs.mkdirSync(dir(), { recursive: true });
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir(), name), body);
}

const status = (over: Partial<InstallStatus> = {}): InstallStatus => ({ running: false, output: '', ...over });

beforeEach(() => {
  configure();
  wipe();
  resetGh();
  resetSpawn();
  setDry(false);
});

describe('withStackSession', () => {
  it('is the boot job’s own status until a session has run', () => {
    const boot = status({ running: true, what: 'PostgreSQL', output: 'apt says…' });
    expect(withStackSession(boot)).toEqual(boot);
  });

  it('adds the session’s transcript, and reads as running while either half is', () => {
    left({ session_id: 'sess-1\n', what: 'PostgreSQL, Redis\n', pid: alivePid() });
    expect(withStackSession(status())).toMatchObject({ sessionId: 'sess-1', running: true, what: 'PostgreSQL, Redis' });
  });

  it('leaves the boot job’s own "what" alone while that is what is running', () => {
    left({ session_id: 'sess-1\n', what: 'PostgreSQL, Redis\n', pid: String(FAKE_PID) });
    expect(withStackSession(status({ running: true, what: 'cloudflared' }))).toMatchObject({ running: true, what: 'cloudflared' });
    // Nothing of the boot job's is running, so the page shows what the session was for.
    expect(withStackSession(status())).toMatchObject({ running: false, what: 'PostgreSQL, Redis' });
  });
});

describe('startStackSession', () => {
  it('starts one claude run for the tools asked for, on the implement model', () => {
    const out = startStackSession(['postgresql', 'redis']);
    expect(out).toEqual({ started: ['postgresql', 'redis'] });
    expect(spawned).toHaveLength(1);
    expect(spawned[0].cmd).toBe('claude');
    expect(spawned[0].args[1]).toBe('/sloth:stack postgresql redis');
    expect(spawned[0].options.env.SLOTH_STACK_INSTALL).toBe('postgresql redis');
    expect(read(path.join(dir(), 'what'))).toBe('PostgreSQL, Redis');
    expect(readLog().join('\n')).toMatch(/stack: install session for PostgreSQL, Redis on /);
  });

  it('clears the last run’s marks first, so its pid and transcript are never read as this run’s', () => {
    left({ pid: String(FAKE_PID), session_id: 'sess-old', what: 'Redis' });
    startStackSession(['redis']);
    expect(read(path.join(dir(), 'session_id'))).not.toBe('sess-old');
    expect(read(path.join(dir(), 'pid'))).toBe(String(FAKE_PID)); // this run's, written by `start`
  });

  it('refuses a second session while one is running, rather than installing twice at once', () => {
    left({ pid: alivePid() });
    expect(startStackSession(['redis'])).toEqual({ started: [], error: 'an install session is already running' });
    expect(spawned).toHaveLength(0);
  });

  it('has nothing to do for an empty list', () => {
    expect(startStackSession([])).toEqual({ started: [] });
    expect(spawned).toHaveLength(0);
  });

  it('only logs in a dry run', () => {
    setDry(true);
    expect(startStackSession(['java'])).toEqual({ started: ['java'] });
    expect(spawned).toHaveLength(0);
    expect(exists(dir(), 'what')).toBe(false);
    expect(readLog().join('\n')).toMatch(/dry-run: would start an install session for Java/);
    setDry(false);
  });
});
