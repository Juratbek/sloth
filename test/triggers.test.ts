import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setDry } from '../server/runner/log';
import { finalReviews, park, pickup, reap, retryStranded, reviews, stop } from '../server/runner/triggers';
import { resetSpawn, spawned } from './child-process-mock';
import { called, onGh, resetGh } from './gh-mock';
import { COLUMNS, alivePid, configure, exists, makeSession, read, readLog, sessionDir, statePath, wipe } from './harness';

vi.mock('../server/runner/gh', () => import('./gh-mock'));
vi.mock('node:child_process', () => import('./child-process-mock'));

const card = (number: number, status: string, extra: Partial<{ labels: string[]; assignees: string[] }> = {}) => ({
  number,
  title: `Issue ${number}`,
  status,
  labels: [],
  assignees: [],
  ...extra,
});

const wired = (prs: Record<number, { pr: number; sha: string; head: string; draft?: boolean; approved?: boolean }[]>) =>
  onGh(/api graphql .*closedByPullRequestsReferences/, {
    data: {
      repository: Object.fromEntries(
        Object.entries(prs).map(([issue, list]) => [
          `i${issue}`,
          { closedByPullRequestsReferences: { nodes: list.map((p) => ({ number: p.pr, state: 'OPEN', isDraft: !!p.draft, headRefOid: p.sha, headRefName: p.head, reviewDecision: p.approved ? 'APPROVED' : null })) } },
        ]),
      ),
    },
  });

const launches = () => spawned.map((s) => s.args[1]);

beforeEach(() => {
  configure({ maxActive: 2, maxAlive: 3, maxRetries: 2, budgetMinutes: 60 });
  wipe();
  resetGh();
  resetSpawn();
  setDry(false);
});

describe('pickup (trigger 1)', () => {
  it('launches unassigned cards of the watched column in board order and moves them to In Progress', async () => {
    onGh(/project item-add/, 'ITEM');
    await pickup([card(5, 'Todo'), card(6, 'Todo', { assignees: ['bob'] }), card(7, 'Backlog'), card(8, 'Todo')]);
    expect(launches()).toEqual(['/sloth:implement 5', '/sloth:implement 8']);
    expect(called(/item-edit .*opt-wip/)).toHaveLength(2);
    expect(spawned[0].options.env.SLOTH_ISSUE).toBe('5');
    expect(spawned[0].options.env.SLOTH_COL_CODE_REVIEW_ID).toBe(COLUMNS.codeReview.id);
    expect(exists(sessionDir('issue', 5), 'pid')).toBe(true);
    expect(exists(sessionDir('issue', 5), 'session_id')).toBe(true);
  });
  it('stops at the session caps and skips a card whose session is alive', async () => {
    makeSession('issue', 1, { pid: alivePid(), 'state.json': { state: 'working' } });
    makeSession('issue', 2, { pid: alivePid(), 'state.json': { state: 'working' } });
    await pickup([card(1, 'Todo'), card(3, 'Todo')]);
    expect(launches()).toEqual([]);
    expect(readLog().at(-1)).toMatch(/#3 queued \(slots full\)/);
  });
  it('a waiting session counts against maxAlive only', async () => {
    makeSession('issue', 1, { pid: alivePid(), 'state.json': { state: 'waiting' } });
    await pickup([card(3, 'Todo')]);
    expect(launches()).toEqual(['/sloth:implement 3']);
  });
  it('resets the retry counter and clears the previous run', async () => {
    makeSession('issue', 3, { retries: '2', blocked: '1', 'state.json': { state: 'done' }, 'inbox/1.md': 'old' });
    await pickup([card(3, 'Todo')]);
    expect(exists(sessionDir('issue', 3), 'retries')).toBe(false);
    expect(exists(sessionDir('issue', 3), 'blocked')).toBe(false);
    expect(exists(sessionDir('issue', 3), 'inbox', '1.md')).toBe(false);
  });
  it('only logs in a dry run', async () => {
    setDry(true);
    await pickup([card(3, 'Todo')]);
    expect(launches()).toEqual([]);
    expect(called(/project/)).toHaveLength(0);
    expect(readLog().at(-1)).toMatch(/dry-run: would launch #3/);
  });
});

describe('retryStranded (trigger 2)', () => {
  it('relaunches an In Progress card with no live session and counts the retry', async () => {
    await retryStranded([card(4, 'In Progress')]);
    expect(launches()).toEqual(['/sloth:implement 4']);
    expect(read(path.join(sessionDir('issue', 4), 'retries'))).toBe('1');
  });
  it('parks the card after maxRetries relaunches in a row', async () => {
    makeSession('issue', 4, { retries: '2' });
    await retryStranded([card(4, 'In Progress')]);
    expect(launches()).toEqual([]);
    expect(called(/issue comment 4 .*stopped without finishing 2 times/)).toHaveLength(1);
    expect(called(/item-edit .*opt-help/)).toHaveLength(1);
    expect(exists(sessionDir('issue', 4), 'retries')).toBe(false);
  });
  it('leaves a blocked card alone', async () => {
    makeSession('issue', 4, { blocked: '1' });
    await retryStranded([card(4, 'In Progress')]);
    expect(launches()).toEqual([]);
  });
});

describe('park', () => {
  it('blocks in place when no needs-help column is configured', async () => {
    configure({ statusField: { id: 'PVTSSF_1', columns: { ...COLUMNS, needsHelp: { id: '', name: '' } } } });
    await park(9, 'it broke.');
    expect(called(/item-edit/)).toHaveLength(0);
    expect(exists(sessionDir('issue', 9), 'blocked')).toBe(true);
  });
  it('mentions the help logins', async () => {
    configure({ helpLogins: ['dana'] });
    await park(9, 'it broke.');
    expect(called(/issue comment 9 [\s\S]*cc @dana$/)).toHaveLength(1);
  });
});

describe('reviews (trigger 4)', () => {
  it("reviews a human's PR once per head and skips Sloth's own branches", async () => {
    wired({ 1: [{ pr: 10, sha: 'aaa', head: 'feature/x' }], 2: [{ pr: 11, sha: 'bbb', head: 'sloth/issue-2-fix' }] });
    const board = [card(1, 'Code Review'), card(2, 'Code Review')];
    await reviews(board);
    expect(launches()).toEqual(['/sloth:review 10']);
    expect(spawned[0].options.env.SLOTH_PR).toBe('10');
    expect(exists(statePath('reviewed', '10-aaa'))).toBe(true);
    resetSpawn();
    await reviews(board);
    expect(launches()).toEqual([]);
  });
  it('uses the review model and marks nothing in a dry run', async () => {
    configure({ models: { review: 'sonnet' } });
    wired({ 1: [{ pr: 10, sha: 'aaa', head: 'feature/x' }] });
    setDry(true);
    await reviews([card(1, 'Code Review')]);
    expect(exists(statePath('reviewed', '10-aaa'))).toBe(false);
    expect(readLog().at(-1)).toMatch(/dry-run: would review PR #10/);
  });
});

describe('finalReviews (trigger 5)', () => {
  it('reviews Approved cards — assigned too — on the final model, except labelled ones', async () => {
    wired({ 1: [{ pr: 10, sha: 'aaa', head: 'sloth/issue-1-x', approved: true }], 3: [{ pr: 12, sha: 'ccc', head: 'y' }] });
    await finalReviews([card(1, 'Approved', { assignees: ['bob'] }), card(2, 'Approved', { labels: ['Fable: approved'] }), card(3, 'Approved')]);
    expect(launches()).toEqual(['/sloth:review 10 final', '/sloth:review 12 final']);
    expect(spawned[0].args).toContain('fable');
    expect(exists(statePath('approved', '10-aaa'))).toBe(true);
  });
  it('does nothing without an Approved column', async () => {
    configure({ statusField: { id: 'PVTSSF_1', columns: { ...COLUMNS, approved: { id: '', name: '' } } } });
    await finalReviews([card(1, 'Approved')]);
    expect(called(/graphql/)).toHaveLength(0);
  });
});

describe('reap', () => {
  it('forgets a dead session and pauses the watcher after a usage-limit exit', async () => {
    makeSession('issue', 1, { pid: '2000000000', 'run.log': 'working…\nClaude AI usage limit reached|123\n' });
    makeSession('review', 5, { pid: '2000000000', 'run.log': 'all good\n' });
    fs.mkdirSync(statePath('reviewed'), { recursive: true });
    fs.writeFileSync(statePath('reviewed', '5-abc'), '');
    await reap();
    expect(exists(sessionDir('issue', 1), 'pid')).toBe(false);
    expect(exists(sessionDir('review', 5), 'pid')).toBe(false);
    expect(Number(read(statePath('paused_until')))).toBeGreaterThan(Date.now() / 1000 + 1700);
    expect(exists(statePath('reviewed', '5-abc'))).toBe(true);
  });
  it('drops the review marker when a review died on the limit, so the head is reviewed again', async () => {
    makeSession('review', 5, { pid: '2000000000', 'run.log': 'usage limit reached\n' });
    fs.mkdirSync(statePath('reviewed'), { recursive: true });
    fs.writeFileSync(statePath('reviewed', '5-abc'), '');
    await reap();
    expect(exists(statePath('reviewed', '5-abc'))).toBe(false);
  });
});

describe('stop', () => {
  it('ends a parked run whose process is gone: cleaned up, marked done, card untouched', async () => {
    makeSession('issue', 7, { pid: '2000000000', 'state.json': { state: 'waiting', step: 'Q' }, 'preview.json': '{}' });
    expect(await stop('issue', 7, 'from the monitor', 'why')).toBe(true);
    expect(JSON.parse(read(path.join(sessionDir('issue', 7), 'state.json')))).toMatchObject({ state: 'done' });
    expect(exists(sessionDir('issue', 7), 'preview.json')).toBe(false);
    expect(called(/item-edit/)).toHaveLength(0);
  });
  it('has nothing to end for a dead working run or a dead review', async () => {
    makeSession('issue', 7, { pid: '2000000000', 'state.json': { state: 'working' } });
    makeSession('review', 8, { pid: '2000000000' });
    expect(await stop('issue', 7, 'x', 'y')).toBe(false);
    expect(await stop('review', 8, 'x', 'y')).toBe(false);
  });
});
