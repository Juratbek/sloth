import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { blockedCards, isCardBlocked, pruneBlocked, unblock } from '../server/runner/blocked';
import type { BoardItem } from '../server/runner/board';
import { setDry } from '../server/runner/log';
import { openSweep, qaSweep } from '../server/runner/qa';
import { resetSpawn, spawned } from './child-process-mock';
import { called, onGh, resetGh } from './gh-mock';
import { COLUMNS, card, configure, exists, makeSession, readLog, ref, sessionDir, statePath, wipe } from './harness';

vi.mock('../server/runner/gh', () => import('./gh-mock'));
vi.mock('node:child_process', () => import('./child-process-mock'));

/** The QA column is opt-in, so this suite configures its own; `at` in the past makes every sweep due. */
const QA = { id: 'opt-qa', name: 'QA' };
const HEAD = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);

const posted: Record<string, any>[] = [];
const log = () => readLog().join('\n');

/** Where the QA branch is; the handler reads it afresh, so a suite may follow the branch as it moves. */
let headSha = HEAD;

/** One sweep of the board with the QA branch at `sha` — forced, so the day's own sweep is left alone. */
async function sweepOn(sha: string, board: BoardItem[]): Promise<void> {
  headSha = sha;
  await openSweep(true);
  await qaSweep(board);
}

/** A QA run that has already ended without a verdict `n` times on `sha` — one more than allowed gives up. */
const tried = (issue: number, n: number, sha = HEAD) => makeSession('qa', issue, { retries: String(n), sha });

beforeEach(() => {
  configure({
    statusField: { id: 'PVTSSF_1', columns: { ...COLUMNS, qa: QA } },
    qa: { branch: 'qa', at: '00:00', budgetMinutes: 60 },
    maxRetries: 2,
    helpLogins: ['alice'],
    helpWebhook: 'https://hooks.example.com/x',
    webhookEvents: ['blocked'],
  });
  wipe();
  resetGh();
  resetSpawn();
  setDry(false);
  headSha = HEAD;
  onGh(/api repos\/acme\/widgets\/commits\/qa/, () => headSha);
  posted.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      posted.push(JSON.parse(String(init.body)));
      return { ok: true, status: 200, statusText: 'OK' };
    }),
  );
});
afterEach(() => {
  setDry(false);
  vi.unstubAllGlobals();
});

describe('the QA sweep giving up', () => {
  it('blocks the card, says so on the issue and raises the event', async () => {
    tried(1, 3);
    await sweepOn(HEAD, [card(1, QA.name)]);
    expect(isCardBlocked(ref(1))).toBe(true);
    expect(blockedCards()).toMatchObject([{ issue: 1, title: 'Issue 1', sha: HEAD, reason: expect.stringContaining('without a verdict 3 times on qa @ aaaaaaa') }]);
    expect(spawned).toHaveLength(0);
    expect(called(/issue comment 1 [\s\S]*blocked/)).toHaveLength(1);
    expect(posted).toMatchObject([{ event: 'blocked', issue: 1, column: 'QA', text: expect.stringContaining('#1 is blocked') }]);
    expect(log()).toContain('#1 blocked:');
  });

  it('leaves a card that still has tries in it alone', async () => {
    tried(1, 2);
    await sweepOn(HEAD, [card(1, QA.name)]);
    expect(isCardBlocked(ref(1))).toBe(false);
    expect(log()).toContain('launch QA #1');
  });

  it('keeps the card out of every later sweep, and announces it once', async () => {
    tried(1, 3);
    await sweepOn(HEAD, [card(1, QA.name)]);
    // A new head clears the "already tested" marker; the block is what still holds the card back.
    await sweepOn(NEXT, [card(1, QA.name)]);
    expect(spawned).toHaveLength(0);
    expect(posted).toHaveLength(1);
    expect(called(/issue comment 1/)).toHaveLength(1);
  });

  it('writes and announces nothing on a dry run', async () => {
    tried(1, 3);
    setDry(true);
    await sweepOn(HEAD, [card(1, QA.name)]);
    expect(isCardBlocked(ref(1))).toBe(false);
    expect(posted).toHaveLength(0);
    expect(called(/issue comment/)).toHaveLength(0);
    expect(log()).toContain('dry-run: would block #1');
  });
});

describe('lifting a block', () => {
  it('forgets the block, the heads already tested and the retry count, so the next sweep tests the card', async () => {
    tried(1, 3);
    await sweepOn(HEAD, [card(1, QA.name)]);
    expect(exists(statePath('qa', `1-${HEAD}`))).toBe(true);

    expect(unblock(ref(1), 'from the monitor')).toBe(true);
    expect(isCardBlocked(ref(1))).toBe(false);
    expect(exists(statePath('qa', `1-${HEAD}`))).toBe(false);
    expect(exists(sessionDir('qa', 1), 'retries')).toBe(false);
    expect(log()).toContain('#1 unblocked (from the monitor)');

    await sweepOn(HEAD, [card(1, QA.name)]);
    expect(log()).toContain('launch QA #1');
    expect(spawned).toHaveLength(1);
  });

  it('is nothing to do on a card that is not blocked', () => {
    expect(unblock(ref(1), 'from the monitor')).toBe(false);
    expect(log()).toBe('');
  });

  it('happens on its own once the card leaves the QA column', async () => {
    tried(1, 3);
    await sweepOn(HEAD, [card(1, QA.name)]);
    pruneBlocked([card(1, QA.name)]);
    expect(isCardBlocked(ref(1))).toBe(true);
    pruneBlocked([card(1, COLUMNS.done.name)]);
    expect(isCardBlocked(ref(1))).toBe(false);
    expect(log()).toContain('#1 unblocked (the card left QA)');
  });

  it('happens on its own once the issue is closed', async () => {
    tried(1, 3);
    await sweepOn(HEAD, [card(1, QA.name)]);
    pruneBlocked([card(1, QA.name, { closed: true })]);
    expect(isCardBlocked(ref(1))).toBe(false);
  });
});
