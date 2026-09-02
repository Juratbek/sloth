import fs from 'node:fs';
import path from 'node:path';
import type { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The tunnel is a child process that prints its address on stdout, so the fake one here hands its
 * streams back to the test: `speak()` is the tool announcing where it can be reached, which is what
 * sets everything after it going.
 */
const h = vi.hoisted(() => ({ children: [] as { cmd: string; stdout: PassThrough }[] }));

vi.mock('node:child_process', async () => {
  const { PassThrough: PT } = await import('node:stream');
  const { EventEmitter: EE } = await import('node:events');
  return {
    spawn: (cmd: string) => {
      const child = Object.assign(new EE(), { stdout: new PT(), stderr: new PT(), kill() {}, unref() {} });
      h.children.push({ cmd, stdout: child.stdout });
      return child;
    },
  };
});
vi.mock('../server/runner/gh', () => import('./gh-mock'));
// cloudflared is on this machine; which one it is does not matter to what is under test.
vi.mock('../server/install', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/install')>()),
  which: (cmd: string) => `/usr/local/bin/${cmd}`,
}));

import { previews, previewState } from '../server/runner/preview';
import { setDry } from '../server/runner/log';
import { called, fail, onGh, resetGh } from './gh-mock';
import { configure, makeSession, readLog, sessionDir, wipe } from './harness';

const TUNNEL = 'https://calm-sloth-42.trycloudflare.com';

/** The tunnel tool printing its address, and whatever that sets off, run to completion. */
async function speak(): Promise<void> {
  h.children.at(-1)!.stdout.write(`INF |  ${TUNNEL}  |\n`);
  await new Promise((r) => setTimeout(r, 20));
}

beforeEach(() => {
  configure({ previewHours: 2 });
  wipe();
  resetGh();
  setDry(false);
  h.children.length = 0;
});

describe('a preview whose comment GitHub refuses', () => {
  it('is not recorded as up, and the link is posted on a later tick', async () => {
    makeSession('issue', 1, { 'preview.json': { url: 'http://localhost:3000' }, 'state.json': { state: 'done' } });
    onGh(/issues\/1\/comments/, fail('HTTP 502'));

    // First tick: the tunnel comes up and prints its address, but the comment carrying it does not land.
    await previews();
    await speak();
    expect(called(/issues\/1\/comments/)).toHaveLength(1);
    expect(previewState(1)?.url).toBeUndefined();
    expect(readLog().join('\n')).not.toMatch(/preview #1 up at/);
    expect(readLog().join('\n')).toMatch(/preview #1: comment failed: HTTP 502/);

    // Second tick: same tunnel, same address, GitHub back — the PR gets its link after all.
    resetGh();
    onGh(/issues\/1\/comments/, '9001');
    await previews();
    expect(called(/issues\/1\/comments/)).toHaveLength(1);
    expect(previewState(1)).toMatchObject({ url: TUNNEL, commentId: 9001 });
    expect(readLog().join('\n')).toMatch(new RegExp(`preview #1 up at ${TUNNEL}`));

    // And then it is left alone: an announced preview is not commented on again every tick.
    resetGh();
    await previews();
    expect(called(/issues\/1\/comments/)).toHaveLength(0);
  });

  it('opens no second tunnel while the first one is up', async () => {
    makeSession('issue', 2, { 'preview.json': { url: 'http://localhost:3000' }, 'state.json': { state: 'done' } });
    onGh(/issues\/2\/comments/, fail('HTTP 502'));
    await previews();
    await speak();
    await previews();
    expect(h.children).toHaveLength(1);
  });
});

describe('a preview whose comment lands', () => {
  it('records the address and the comment it was posted as', async () => {
    makeSession('issue', 3, { 'preview.json': { url: 'http://127.0.0.1:5173', login: 'admin / hunter2' }, 'state.json': { state: 'done' } });
    onGh(/issues\/3\/comments/, '77');
    await previews();
    await speak();
    expect(previewState(3)).toMatchObject({ url: TUNNEL, commentId: 77 });
    expect(called(/issues\/3\/comments/)[0].line).toContain('admin / hunter2');
    expect(fs.existsSync(path.join(sessionDir('issue', 3), 'preview-state.json'))).toBe(true);
  });
});
