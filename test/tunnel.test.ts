import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Every `cloudflared` this test starts, so a launch that never happened is visible as a missing one. */
const h = vi.hoisted(() => ({ children: [] as { kill: () => void; emit: (e: string, v?: unknown) => boolean }[] }));

vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    spawn: () => {
      const child = Object.assign(new EventEmitter(), { stdout: null, stderr: null, kill() {} });
      h.children.push(child);
      return child;
    },
  };
});
vi.mock('../server/install', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/install')>()),
  which: (cmd: string) => `/usr/local/bin/${cmd}`,
}));

import { remoteStatus, startTunnel, stopTunnel } from '../server/remote';
import { setDry } from '../server/runner/log';
import { configure, readLog, wipe } from './harness';

/** The tool exits without ever printing a URL, and the retry it schedules comes due. */
async function dropAndWait(): Promise<void> {
  h.children.at(-1)!.emit('exit', 1);
  await vi.advanceTimersByTimeAsync(70_000);
}

beforeEach(() => {
  configure();
  wipe();
  setDry(false);
  h.children.length = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  stopTunnel();
  vi.useRealTimers();
});

describe('the remote tunnel', () => {
  it('keeps retrying however often the tool drops', async () => {
    // The retry used to be gated on `status.error` being unset, and nothing but a printed URL or a
    // stop ever cleared it: two drops in a row meant exactly two launches, ever, and remote access
    // stayed dead until Sloth was restarted.
    startTunnel(4400);
    expect(h.children).toHaveLength(1);
    for (const expected of [2, 3, 4, 5]) {
      await dropAndWait();
      expect(h.children).toHaveLength(expected);
    }
    expect(remoteStatus().error).toMatch(/cloudflared exited with 1, retrying/);
  });

  it('counts a child that errors and then exits as one failure, not two', async () => {
    startTunnel(4400);
    const child = h.children.at(-1)!;
    child.emit('error', new Error('spawn ENOENT'));
    child.emit('exit', 1);
    await vi.advanceTimersByTimeAsync(70_000);
    expect(h.children).toHaveLength(2);
    expect(readLog().filter((l) => /remote: spawn ENOENT/.test(l))).toHaveLength(1);
  });

  it('starts nothing more once it is stopped', async () => {
    startTunnel(4400);
    stopTunnel();
    await vi.advanceTimersByTimeAsync(70_000);
    expect(h.children).toHaveLength(1);
    expect(remoteStatus()).toEqual({});
  });
});
