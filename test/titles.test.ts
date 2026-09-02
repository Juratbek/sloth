import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cachedTitles, titleFor } from '../server/watcher';
import { onExecFile, resetSpawn } from './child-process-mock';
import { configure, wipe } from './harness';

vi.mock('node:child_process', () => import('./child-process-mock'));

/**
 * The monitor's title cache. Sloth is one process that runs for weeks and every board poll asks about
 * every card, so a map that only ever grew was a slow leak with a title in every entry.
 */

/** One title per number, as `gh api repos/…/issues/<n> --jq .title` answers it. */
const titles = () => onExecFile(/gh api repos/, { stdout: (line) => `Issue ${/issues\/(\d+)/.exec(line)?.[1]}` });

/** The fetch is fired and forgotten; a macrotask later every answer is in. */
const settle = () => new Promise((r) => setImmediate(r));

/** Asks for `n` and waits for the answer — the first call always returns undefined. */
async function ask(n: number): Promise<string | undefined> {
  titleFor(n, 5000);
  await settle();
  return titleFor(n, 5000);
}

beforeEach(() => {
  configure();
  wipe();
  resetSpawn();
  titles();
});

describe('titleFor', () => {
  it('answers from the cache after one call, and keeps at most a few hundred numbers', async () => {
    expect(await ask(1)).toBe('Issue 1');
    for (let n = 2; n <= 620; n++) await ask(n);
    const held = cachedTitles();
    expect(held.length).toBeLessThanOrEqual(500);
    // The newest are still there; the oldest were let go, and cost one `gh` call if they come back.
    expect(held).toContain(620);
    expect(held).not.toContain(1);
    expect(titleFor(620, 5000)).toBe('Issue 620');
    expect(titleFor(1, 5000)).toBeUndefined();
  });

  it('keeps the number the UI keeps asking about, and lets the one-offs go', async () => {
    expect(await ask(7)).toBe('Issue 7');
    for (let n = 100; n < 700; n++) {
      await ask(n);
      titleFor(7, 5000); // #7 is on screen the whole time
    }
    expect(cachedTitles()).toContain(7);
  });

  it('asks for nothing when the GitHub rate limit is nearly spent', async () => {
    expect(titleFor(9001, 10)).toBeUndefined();
    await settle();
    expect(cachedTitles()).not.toContain(9001);
  });
});
