import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { killTree } from '../server/runner/kill';
import { executed, resetSpawn } from './child-process-mock';

vi.mock('node:child_process', () => import('./child-process-mock'));

/**
 * One helper for both machines Sloth runs on. On macOS and Linux a session is a process group; on Windows
 * a negative pid is an error, and a session killed there used to keep its app, its database and its
 * browser — `taskkill /T` is the tree walk that stands in for the group.
 */

const platform = process.platform;
const asPlatform = (value: string) => Object.defineProperty(process, 'platform', { value, configurable: true });

beforeEach(() => resetSpawn());
afterEach(() => asPlatform(platform));

describe('killTree', () => {
  it('signals the process group and then the process itself on macOS and Linux, waking it first', async () => {
    asPlatform('darwin');
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      await killTree(4242);
      expect(kill.mock.calls).toEqual([
        [-4242, 'SIGCONT'],
        [-4242, 'SIGTERM'],
        [4242, 'SIGCONT'],
        [4242, 'SIGTERM'],
      ]);
      // A paused run cannot act on a SIGTERM, so SIGCONT comes first — and nothing shells out here.
      expect(executed).toHaveLength(0);
    } finally {
      kill.mockRestore();
    }
  });

  it('honours the signal it was given', async () => {
    asPlatform('linux');
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      await killTree(7, 'SIGKILL');
      expect(kill.mock.calls.map(([, sig]) => sig)).toEqual(['SIGCONT', 'SIGKILL', 'SIGCONT', 'SIGKILL']);
    } finally {
      kill.mockRestore();
    }
  });

  it('survives a process that raced its own exit', async () => {
    asPlatform('darwin');
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    });
    try {
      await expect(killTree(999)).resolves.toBeUndefined();
    } finally {
      kill.mockRestore();
    }
  });

  it('kills the whole tree with taskkill on Windows, and never signals a negative pid', async () => {
    asPlatform('win32');
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      await killTree(1234);
      expect(kill).not.toHaveBeenCalled();
      expect(executed.map((e) => e.line)).toEqual(['taskkill /T /F /PID 1234']);
    } finally {
      kill.mockRestore();
    }
  });

  it('has nothing to kill for a pid that was never recorded', async () => {
    asPlatform('win32');
    await killTree(0);
    expect(executed).toHaveLength(0);
  });
});
