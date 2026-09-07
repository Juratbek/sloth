import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTunnel, stopTunnel } from '../server/remote';
import { setDry } from '../server/runner/log';
import { launch, launchApproved, statusReply } from '../server/runner/spawn';
import { resetSpawn, spawned } from './child-process-mock';
import { called, resetGh } from './gh-mock';
import { configure, read, ref, sessionDir, wipe } from './harness';

vi.mock('../server/runner/gh', () => import('./gh-mock'));
vi.mock('node:child_process', () => import('./child-process-mock'));

const links = () => called(/^gh issue comment \d+ --repo acme\/widgets --body .*follow it live/);
/** The comment is written after `start` returns, on its own; give it the turn it needs. */
const flush = () => vi.waitFor(() => expect(spawned.length).toBeGreaterThan(0)).then(() => new Promise((r) => setImmediate(r)));

beforeEach(() => {
  wipe();
  resetGh();
  resetSpawn();
  setDry(false);
});
afterEach(() => stopTunnel());

describe('the session link on the issue', () => {
  it('tells the issue where its implement run can be watched, on the public address', async () => {
    configure({ publicUrl: 'https://sloth.example.com', liveLinks: true });
    startTunnel(4400);
    expect(await launch(ref(4))).toBe(true);
    await flush();
    const id = read(path.join(sessionDir('issue', 4), 'session_id')).trim();
    expect(links()).toHaveLength(1);
    expect(links()[0].args.at(-1)).toBe(`**Sloth:** An implement session started on \`fable\` — follow it live: https://sloth.example.com/sessions/${id}`);
  });
  it('names a final review as one, on the issue the PR closes', async () => {
    configure({ publicUrl: 'https://sloth.example.com', liveLinks: true });
    startTunnel(4400);
    expect(launchApproved(ref(12), ref(4), 'abc1234')).toBe(true);
    await flush();
    expect(links()).toHaveLength(1);
    expect(links()[0].args.slice(1, 3)).toEqual(['comment', '4']);
    expect(links()[0].args.at(-1)).toMatch(/^\*\*Sloth:\*\* A review session started on `fable` — follow it live: https:\/\/sloth\.example\.com\/sessions\//);
  });
  it('writes nothing when no address is known — a link to localhost helps nobody', async () => {
    configure({ liveLinks: true });
    expect(await launch(ref(4))).toBe(true);
    await flush();
    expect(links()).toHaveLength(0);
  });
  it('writes nothing by default: the public address goes to a thread everyone can read only when asked to', async () => {
    configure({ publicUrl: 'https://sloth.example.com' });
    startTunnel(4400);
    expect(await launch(ref(4))).toBe(true);
    await flush();
    expect(links()).toHaveLength(0);
  });
  it('is not a status reply: that borrows the issue directory and is answered on the thread already', async () => {
    configure({ publicUrl: 'https://sloth.example.com', liveLinks: true });
    startTunnel(4400);
    expect(statusReply(ref(4), '77')).toBe(true);
    await flush();
    expect(links()).toHaveLength(0);
  });
});
