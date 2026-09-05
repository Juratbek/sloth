import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cfg } from '../server/config';
import { RETRY_MS, checkoutState, cloneRepo, ensureCheckout, forgetCheckout } from '../server/checkout';
import { setDry } from '../server/runner/log';
import { called, fail, onCommand, resetGh } from './gh-mock';
import { configure, readLog, runnerRoot, wipe } from './harness';

vi.mock('../server/runner/gh', () => import('./gh-mock'));

/**
 * The runner checkout is Sloth's to make. A saved config whose `runnerRoot` is not there yet is cloned
 * into on the next tick, not left for the user to notice when every launch fails its fetch.
 */

const clones = () => called(/^gh repo clone/);
/** `gh repo clone` as it behaves: the target directory appears with a `.git` in it. */
const cloneWorks = () =>
  onCommand(/^gh repo clone/, ({ args }) => {
    fs.mkdirSync(path.join(args[3], '.git'), { recursive: true });
    return '';
  });

beforeEach(() => {
  configure();
  wipe();
  resetGh();
  forgetCheckout();
  setDry(false);
  fs.rmSync(runnerRoot(), { recursive: true, force: true });
});

describe('ensureCheckout', () => {
  it('clones the repository into a runner root that is not there and reports it ready', async () => {
    cloneWorks();
    expect(checkoutState(runnerRoot())).toEqual({ kind: 'missing' });
    expect(await ensureCheckout()).toBe(true);
    expect(clones().map((c) => c.args)).toEqual([['repo', 'clone', 'acme/widgets', runnerRoot()]]);
    expect(checkoutState(runnerRoot())).toEqual({ kind: 'ready' });
    expect(readLog().join('\n')).toContain(`checkout: acme/widgets cloned into ${runnerRoot()}`);
  });

  it('clones into an empty directory too — a folder someone made for it', async () => {
    cloneWorks();
    fs.mkdirSync(runnerRoot(), { recursive: true });
    expect(await ensureCheckout()).toBe(true);
    expect(clones()).toHaveLength(1);
  });

  it('leaves a checkout that is there alone', async () => {
    fs.mkdirSync(path.join(runnerRoot(), '.git'), { recursive: true });
    expect(await ensureCheckout()).toBe(true);
    expect(clones()).toHaveLength(0);
  });

  it('does not touch a folder with somebody else\'s files in it, and says so', async () => {
    fs.mkdirSync(runnerRoot(), { recursive: true });
    fs.writeFileSync(path.join(runnerRoot(), 'notes.txt'), 'mine');
    expect(await ensureCheckout()).toBe(false);
    expect(clones()).toHaveLength(0);
    expect(checkoutState(runnerRoot())).toMatchObject({ kind: 'error', error: expect.stringContaining('is not a git checkout') });
  });

  it('keeps the reason a clone failed and does not try again for ten minutes', async () => {
    onCommand(/^gh repo clone/, fail('GraphQL: Could not resolve to a Repository with the name \'acme/widgets\'.'));
    const at = Date.now();
    expect(await ensureCheckout(at)).toBe(false);
    expect(checkoutState(runnerRoot())).toEqual({ kind: 'error', error: "GraphQL: Could not resolve to a Repository with the name 'acme/widgets'." });
    expect(readLog().join('\n')).toContain('checkout: cloning acme/widgets into');
    expect(await ensureCheckout(at + RETRY_MS - 1000)).toBe(false);
    expect(clones()).toHaveLength(1);
    resetGh();
    cloneWorks();
    expect(await ensureCheckout(at + RETRY_MS)).toBe(true);
    expect(checkoutState(runnerRoot())).toEqual({ kind: 'ready' });
  });

  it('names gh when it is not installed', async () => {
    onCommand(/^gh repo clone/, fail('spawn gh ENOENT'));
    await ensureCheckout();
    expect(checkoutState(runnerRoot())).toEqual({ kind: 'error', error: '`gh` was not found on PATH' });
  });

  it('runs one clone for two callers at once and says it is cloning meanwhile', async () => {
    let finish!: () => void;
    onCommand(/^gh repo clone/, ({ args }) =>
      new Promise<string>((resolve) => {
        finish = () => {
          fs.mkdirSync(path.join(args[3], '.git'), { recursive: true });
          resolve('');
        };
      }),
    );
    const a = ensureCheckout();
    const b = cloneRepo('acme/widgets', runnerRoot());
    await new Promise((r) => setTimeout(r, 0));
    expect(checkoutState(runnerRoot())).toEqual({ kind: 'cloning', repo: 'acme/widgets' });
    finish();
    expect(await Promise.all([a, b])).toEqual([true, { ok: true, path: runnerRoot() }]);
    expect(clones()).toHaveLength(1);
  });

  it('only says what it would do in a dry run', async () => {
    setDry(true);
    expect(await ensureCheckout()).toBe(false);
    expect(clones()).toHaveLength(0);
    expect(readLog().join('\n')).toContain('dry-run: would clone acme/widgets');
    expect(checkoutState(runnerRoot())).toEqual({ kind: 'missing' });
  });
});

describe('cloneRepo (the Settings button)', () => {
  it('refuses a name that is not owner/repo', async () => {
    expect(await cloneRepo('widgets', runnerRoot())).toEqual({ ok: false, error: 'repo must be owner/repo' });
  });

  it('answers with the path when the checkout is already there', async () => {
    fs.mkdirSync(path.join(runnerRoot(), '.git'), { recursive: true });
    expect(await cloneRepo('acme/widgets', runnerRoot())).toEqual({ ok: true, path: runnerRoot() });
    expect(clones()).toHaveLength(0);
  });
});
