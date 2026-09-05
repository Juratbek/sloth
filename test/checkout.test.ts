import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cfg } from '../server/config';
import { RETRY_MS, checkoutReady, checkoutState, cloneRepo, ensureCheckout, forgetCheckout } from '../server/checkout';
import { setDry } from '../server/runner/log';
import { called, fail, onCommand, resetGh } from './gh-mock';
import { configure, readLog, wipe } from './harness';

vi.mock('../server/runner/gh', () => import('./gh-mock'));

/**
 * The runner checkout is Sloth's to make. A saved config whose `runnerRoot` is not there yet is cloned
 * into on the next tick, not left for the user to notice when every launch fails its fetch.
 */

const clones = () => called(/^gh repo clone/);
const gitIn = (dir: string) => fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
/** `gh repo clone` as it behaves: the directory it was given appears with a `.git` in it. */
const cloneWorks = () =>
  onCommand(/^gh repo clone/, ({ args }) => {
    gitIn(args[3]);
    return '';
  });
/** A clone held open until the test lets it finish. */
function cloneWaits(): () => void {
  let finish!: () => void;
  onCommand(/^gh repo clone/, ({ args }) =>
    new Promise<string>((resolve) => {
      finish = () => {
        gitIn(args[3]);
        resolve('');
      };
    }),
  );
  return () => finish();
}
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  configure();
  wipe();
  resetGh();
  forgetCheckout();
  setDry(false);
  fs.rmSync(cfg().runnerRoot, { recursive: true, force: true });
  fs.rmSync(`${cfg().runnerRoot}.cloning`, { recursive: true, force: true });
});

afterEach(() => {
  vi.useRealTimers();
  // A test may leave a file where the next one's `configure` wants a directory.
  fs.rmSync(cfg().runnerRoot, { recursive: true, force: true });
});

describe('ensureCheckout', () => {
  it('clones the repository into a runner root that is not there and reports it ready', async () => {
    cloneWorks();
    expect(checkoutState()).toEqual({ kind: 'missing' });
    expect(await ensureCheckout()).toBe(true);
    // Into a directory beside the root, renamed into place once it is whole.
    expect(clones().map((c) => c.args)).toEqual([['repo', 'clone', 'acme/widgets', `${cfg().runnerRoot}.cloning`]]);
    expect(checkoutState()).toEqual({ kind: 'ready' });
    expect(fs.existsSync(`${cfg().runnerRoot}.cloning`)).toBe(false);
    expect(readLog().join('\n')).toContain(`checkout: acme/widgets cloned into ${cfg().runnerRoot}`);
  });

  it('clones into an empty directory too — a folder someone made for it', async () => {
    cloneWorks();
    fs.mkdirSync(cfg().runnerRoot, { recursive: true });
    expect(await ensureCheckout()).toBe(true);
    expect(clones()).toHaveLength(1);
  });

  it('leaves a checkout that is there alone', async () => {
    fs.mkdirSync(path.join(cfg().runnerRoot, '.git'), { recursive: true });
    expect(await ensureCheckout()).toBe(true);
    expect(clones()).toHaveLength(0);
  });

  it('does not touch a folder with somebody else\'s files in it, and says so', async () => {
    fs.mkdirSync(cfg().runnerRoot, { recursive: true });
    fs.writeFileSync(path.join(cfg().runnerRoot, 'notes.txt'), 'mine');
    expect(await ensureCheckout()).toBe(false);
    expect(clones()).toHaveLength(0);
    expect(checkoutState()).toMatchObject({ kind: 'error', error: expect.stringContaining('is not a git checkout') });
  });

  it('is not ready while the clone is still running, whatever git has written so far', async () => {
    const finish = cloneWaits();
    const running = ensureCheckout();
    await settle();
    // git writes `.git` before it fetches anything — a root with one is a clone in progress, not a checkout.
    expect(fs.existsSync(path.join(`${cfg().runnerRoot}.cloning`, '.git'))).toBe(false);
    expect(checkoutReady()).toBe(false);
    expect(checkoutState()).toEqual({ kind: 'cloning', repo: 'acme/widgets' });
    finish();
    expect(await running).toBe(true);
    expect(checkoutReady()).toBe(true);
  });

  it('deletes what a clone that did not finish left behind before trying again', async () => {
    gitIn(`${cfg().runnerRoot}.cloning`);
    fs.writeFileSync(path.join(`${cfg().runnerRoot}.cloning`, 'half'), '');
    onCommand(/^gh repo clone/, ({ args }) => {
      expect(fs.existsSync(args[3])).toBe(false);
      gitIn(args[3]);
      return '';
    });
    expect(await ensureCheckout()).toBe(true);
    expect(fs.existsSync(path.join(cfg().runnerRoot, 'half'))).toBe(false);
  });

  it('removes its own leftovers when the clone fails, so the next try starts clean', async () => {
    onCommand(/^gh repo clone/, ({ args }) => {
      gitIn(args[3]);
      return fail('timed out after 600s');
    });
    expect(await ensureCheckout()).toBe(false);
    expect(fs.existsSync(`${cfg().runnerRoot}.cloning`)).toBe(false);
    expect(fs.existsSync(cfg().runnerRoot)).toBe(false);
    expect(checkoutState()).toEqual({ kind: 'error', error: 'timed out after 600s' });
  });

  it('refuses a path that is a file', async () => {
    fs.writeFileSync(cfg().runnerRoot, 'not a directory');
    expect(await ensureCheckout()).toBe(false);
    expect(clones()).toHaveLength(0);
    expect(checkoutState()).toMatchObject({ kind: 'error', error: expect.stringContaining('is a file, not a directory') });
  });

  it('keeps the reason a clone failed and does not try again for ten minutes', async () => {
    const at = Date.parse('2026-09-05T10:00:00Z');
    vi.useFakeTimers({ toFake: ['Date'], now: at });
    onCommand(/^gh repo clone/, fail('GraphQL: Could not resolve to a Repository with the name \'acme/widgets\'.'));
    expect(await ensureCheckout(at)).toBe(false);
    expect(checkoutState()).toEqual({ kind: 'error', error: "GraphQL: Could not resolve to a Repository with the name 'acme/widgets'." });
    expect(readLog().join('\n')).toContain('checkout: cloning acme/widgets into');
    expect(await ensureCheckout(at + RETRY_MS - 1000)).toBe(false);
    expect(clones()).toHaveLength(1);
    resetGh();
    cloneWorks();
    expect(await ensureCheckout(at + RETRY_MS)).toBe(true);
    expect(checkoutState()).toEqual({ kind: 'ready' });
  });

  it('tries again at once when the repository was changed under a failure — the failure was the old name\'s', async () => {
    const at = Date.parse('2026-09-05T10:00:00Z');
    vi.useFakeTimers({ toFake: ['Date'], now: at });
    onCommand(/^gh repo clone acme\/wigdets/, fail('Could not resolve to a Repository'));
    configure({ repo: 'acme/wigdets' });
    fs.rmSync(cfg().runnerRoot, { recursive: true, force: true });
    expect(await ensureCheckout(at)).toBe(false);
    configure({ repo: 'acme/widgets' });
    fs.rmSync(cfg().runnerRoot, { recursive: true, force: true });
    cloneWorks();
    expect(await ensureCheckout(at + 1000)).toBe(true);
    expect(clones().map((c) => c.args[2])).toEqual(['acme/wigdets', 'acme/widgets']);
  });

  it('names gh when it is not installed', async () => {
    onCommand(/^gh repo clone/, fail('spawn gh ENOENT'));
    await ensureCheckout();
    expect(checkoutState()).toEqual({ kind: 'error', error: '`gh` was not found on PATH' });
  });

  it('runs one clone for two callers at once and says it is cloning meanwhile', async () => {
    const finish = cloneWaits();
    const a = ensureCheckout();
    const b = cloneRepo('acme/widgets', cfg().runnerRoot);
    await settle();
    expect(checkoutState()).toEqual({ kind: 'cloning', repo: 'acme/widgets' });
    finish();
    expect(await Promise.all([a, b])).toEqual([true, { ok: true, path: cfg().runnerRoot }]);
    expect(clones()).toHaveLength(1);
  });

  it('refuses another repository into a root being cloned into, rather than calling it ready', async () => {
    const finish = cloneWaits();
    const running = ensureCheckout();
    await settle();
    expect(await cloneRepo('acme/gadgets', cfg().runnerRoot)).toEqual({ ok: false, error: `a clone of acme/widgets into ${cfg().runnerRoot} is still running` });
    finish();
    await running;
  });

  it('clones two roots one after the other, and knows which is which', async () => {
    const other = path.join(path.dirname(cfg().runnerRoot), 'other');
    const finish = cloneWaits();
    const first = cloneRepo('acme/widgets', cfg().runnerRoot);
    await settle();
    const second = cloneRepo('acme/gadgets', other);
    await settle();
    expect(clones()).toHaveLength(1);
    expect(checkoutState(other)).toEqual({ kind: 'cloning', repo: 'acme/gadgets' });
    finish();
    await first;
    await settle();
    finish();
    expect(await second).toEqual({ ok: true, path: other });
    expect(clones().map((c) => c.args[2])).toEqual(['acme/widgets', 'acme/gadgets']);
  });

  it('only says what it would do in a dry run', async () => {
    setDry(true);
    expect(await ensureCheckout()).toBe(false);
    expect(clones()).toHaveLength(0);
    expect(readLog().join('\n')).toContain('dry-run: would clone acme/widgets');
    expect(checkoutState()).toEqual({ kind: 'missing' });
  });
});

describe('cloneRepo (the Settings button)', () => {
  it('refuses a name that is not owner/repo', async () => {
    expect(await cloneRepo('widgets', cfg().runnerRoot)).toEqual({ ok: false, error: 'repo must be owner/repo' });
  });

  it('answers with the path when the checkout is already there', async () => {
    fs.mkdirSync(path.join(cfg().runnerRoot, '.git'), { recursive: true });
    expect(await cloneRepo('acme/widgets', cfg().runnerRoot)).toEqual({ ok: true, path: cfg().runnerRoot });
    expect(clones()).toHaveLength(0);
  });
});
