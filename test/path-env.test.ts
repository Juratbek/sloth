import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionEnv } from '../server/runner/session-env';
import { servicePath } from '../server/service';
import { configure, wipe } from './harness';

vi.mock('../server/runner/gh', () => import('./gh-mock'));

/**
 * PATH is a `;`-separated list on Windows, which Sloth runs on. Splitting it on `:` there turns
 * `C:\Program Files\nodejs;C:\bin` into three entries that name nothing, and the session — or the launch
 * agent — starts with a PATH on which `git`, `gh` and `claude` are all missing.
 */
let was: string | undefined;

beforeEach(() => {
  configure();
  wipe();
  was = process.env.PATH;
});
afterEach(() => {
  process.env.PATH = was;
});

const entries = (p: string | undefined) => (p ?? '').split(path.delimiter).filter(Boolean);

describe('the PATH a session and the launch agent inherit', () => {
  it('is split and joined on this platform\u2019s delimiter, so every entry survives the round trip', () => {
    const mine = [path.join('one', 'two'), path.join('three', 'four')];
    process.env.PATH = mine.join(path.delimiter);
    for (const built of [entries(sessionEnv(configure().sessionsDir, {}, 'opus', false).PATH), entries(servicePath())]) {
      for (const dir of mine) expect(built).toContain(dir);
      // Nothing was chopped in half, and nothing was pasted together.
      expect(built.some((e) => e.includes(path.delimiter))).toBe(false);
      expect(new Set(built).size).toBe(built.length);
    }
  });

  it('adds the directories a bare login PATH misses, without dropping the ones it had', () => {
    process.env.PATH = path.join('only', 'this');
    const built = entries(sessionEnv(configure().sessionsDir, {}, 'opus', false).PATH);
    expect(built[0]).toBe(path.join('only', 'this'));
    expect(built.length).toBeGreaterThan(1);
  });
});
