import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setDry } from '../server/runner/log';
import { finalReviews, park, pickup, reap, retryStranded, reviews, stop } from '../server/runner/triggers';
import { exitsOf } from '../server/runner/exits';
import { resetSpawn, spawned } from './child-process-mock';
import { called, onGh, resetGh } from './gh-mock';
import { COLUMNS, alivePid, card, configure, exists, makeSession, read, readLog, sessionDir, statePath, wipe } from './harness';

vi.mock('../server/runner/gh', () => import('./gh-mock'));
vi.mock('node:child_process', () => import('./child-process-mock'));

const wired = (prs: Record<number, { pr: number; sha: string; head: string; draft?: boolean; approved?: boolean; checks?: string }[]>) =>
  onGh(/api graphql .*closedByPullRequestsReferences/, {
    data: {
      repository: Object.fromEntries(
        Object.entries(prs).map(([issue, list]) => [
          `i${issue}`,
          {
            closedByPullRequestsReferences: {
              nodes: list.map((p) => ({
                number: p.pr,
                state: 'OPEN',
                isDraft: !!p.draft,
                headRefOid: p.sha,
                headRefName: p.head,
                reviewDecision: p.approved ? 'APPROVED' : null,
                ...(p.checks ? { commits: { nodes: [{ commit: { statusCheckRollup: { state: p.checks } } }] } } : {}),
              })),
            },
          },
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
  it('launches the watched column in board order, assigned or not, and moves the cards to In Progress', async () => {
    onGh(/project item-add/, 'ITEM');
    makeSession('issue', 5, { retries: '1', 'exits.json': [{ at: 1, how: 'x', tail: '' }] });
    await pickup([card(5, 'Todo'), card(6, 'Todo', { labels: ['Sloth: skip'] }), card(7, 'Backlog'), card(8, 'Todo', { assignees: ['bob'] })]);
    expect(launches()).toEqual(['/sloth:implement 5', '/sloth:implement 8']);
    // A fresh pickup starts the count over: no retries, no record of old runs; the log opens with a run header.
    expect(exists(sessionDir('issue', 5), 'retries')).toBe(false);
    expect(exists(sessionDir('issue', 5), 'exits.json')).toBe(false);
    expect(read(path.join(sessionDir('issue', 5), 'run.log'))).toMatch(/^=== sloth run .* · fable ===\n$/);
    expect(called(/item-edit .*opt-wip/)).toHaveLength(2);
    expect(spawned[0].options.env.SLOTH_ISSUE).toBe('5');
    expect(spawned[0].options.env.SLOTH_COL_CODE_REVIEW_ID).toBe(COLUMNS.codeReview.id);
    // The default: an orchestrator on Fable, the implementor subagent on Opus.
    expect(spawned[0].args).toContain('fable');
    expect(spawned[0].options.env.SLOTH_ORCHESTRATOR).toBe('1');
    expect(spawned[0].options.env.SLOTH_IMPLEMENTOR_MODEL).toBe('opus');
  });
  it('runs one plain session on the implement model with the orchestrator off', async () => {
    configure({ orchestrator: false });
    onGh(/project item-add/, 'ITEM');
    await pickup([card(5, 'Todo')]);
    const [s] = spawned;
    expect(s.args[s.args.indexOf('--model') + 1]).toBe('opus');
    expect(s.options.env.SLOTH_ORCHESTRATOR).toBe('0');
  });
  it('starts an orchestrator on its own model and names the implementor model', async () => {
    configure({ orchestrator: true, models: { orchestrator: 'fable', implement: 'sonnet' } });
    onGh(/project item-add/, 'ITEM');
    await pickup([card(5, 'Todo')]);
    const [s] = spawned;
    expect(s.args[s.args.indexOf('--model') + 1]).toBe('fable');
    expect(s.options.env.SLOTH_ORCHESTRATOR).toBe('1');
    expect(s.options.env.SLOTH_IMPLEMENTOR_MODEL).toBe('sonnet');
    expect(s.options.env.SLOTH_MODEL).toBe('fable');
    expect(exists(sessionDir('issue', 5), 'pid')).toBe(true);
    expect(exists(sessionDir('issue', 5), 'session_id')).toBe(true);
  });
  it('takes the highest priority first, unprioritised cards last', async () => {
    await pickup([card(5, 'Todo'), card(6, 'Todo', { priority: 2 }), card(7, 'Todo', { priority: 0 })]);
    expect(launches()).toEqual(['/sloth:implement 7', '/sloth:implement 6', '/sloth:implement 5']);
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
  it('tells the human how every run ended when it parks, then forgets the record', async () => {
    const exits = [
      { at: 1_000_000, how: 'the session ended on its own', step: '4', note: 'running the tester', tail: 'Out of time.\nDone: the API. Left: the UI.' },
      { at: 1_003_600, how: 'the session ended on its own', step: '2', note: 'reading the issue', tail: '' },
    ];
    makeSession('issue', 4, { retries: '2', 'exits.json': exits });
    await retryStranded([card(4, 'In Progress')]);
    const [c] = called(/issue comment 4 /);
    expect(c.line).toMatch(/stopped without finishing 2 times/);
    expect(c.line).toContain('Run 1 of 2 — the session ended on its own at step 4 (running the tester), 1970-01-12 13:46 UTC');
    expect(c.line).toContain('Done: the API. Left: the UI.');
    expect(c.line).toContain('Run 2 of 2 — the session ended on its own at step 2 (reading the issue)');
    expect(c.line).toContain('printed nothing');
    expect(exists(sessionDir('issue', 4), 'exits.json')).toBe(false);
  });
  it('counts the recorded runs when they outnumber the relaunches', async () => {
    makeSession('issue', 4, { retries: '2', 'exits.json': [{ at: 1, how: 'x', tail: '' }, { at: 2, how: 'x', tail: '' }, { at: 3, how: 'x', tail: '' }] });
    await retryStranded([card(4, 'In Progress')]);
    expect(called(/issue comment 4 .*stopped without finishing 3 times/)).toHaveLength(1);
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
  it('reviews Approved cards — skipped too — on the final model, except approved ones', async () => {
    wired({ 1: [{ pr: 10, sha: 'aaa', head: 'sloth/issue-1-x', approved: true }], 3: [{ pr: 12, sha: 'ccc', head: 'y' }] });
    await finalReviews([card(1, 'Approved', { labels: ['Sloth: skip'] }), card(2, 'Approved', { labels: ['Fable: approved'] }), card(3, 'Approved')]);
    expect(launches()).toEqual(['/sloth:review 10 final', '/sloth:review 12 final']);
    expect(spawned[0].args).toContain('fable');
    expect(exists(statePath('approved', '10-aaa'))).toBe(true);
  });
  it('does nothing without an Approved column', async () => {
    configure({ statusField: { id: 'PVTSSF_1', columns: { ...COLUMNS, approved: { id: '', name: '' } } } });
    await finalReviews([card(1, 'Approved')]);
    expect(called(/graphql/)).toHaveLength(0);
  });
  it('waits out a pending check and leaves a red one to trigger 7', async () => {
    wired({ 1: [{ pr: 10, sha: 'aaa', head: 'x', checks: 'PENDING' }], 2: [{ pr: 11, sha: 'bbb', head: 'y', checks: 'FAILURE' }] });
    await finalReviews([card(1, 'Approved'), card(2, 'Approved')]);
    expect(launches()).toEqual([]);
    expect(exists(statePath('approved', '10-aaa'))).toBe(false);
    expect(readLog().join('\n')).toMatch(/final review PR #10 waits for its checks/);
  });
  it('reviews a labelled card again when its head moved after the pass', async () => {
    fs.mkdirSync(statePath('approved'), { recursive: true });
    fs.writeFileSync(statePath('approved', '10-old'), '');
    wired({ 1: [{ pr: 10, sha: 'new', head: 'x' }] });
    const board = [card(1, 'Approved', { labels: ['Fable: approved'] })];
    await finalReviews(board);
    expect(called(/issue edit 1 .*--remove-label Fable: approved/)).toHaveLength(1);
    expect(launches()).toEqual(['/sloth:review 10 final']);
    resetSpawn();
    await finalReviews(board);
    expect(launches()).toEqual([]);
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
  it('records how a working issue run ended, from its state and its last output', async () => {
    const log = '=== sloth run 2026-08-29T10:00:00.000Z · opus ===\nfirst run: usage limit reached\n=== sloth run 2026-08-29T11:00:00.000Z · opus ===\nOut of time. Left: the UI.\n';
    makeSession('issue', 1, { pid: '2000000000', 'state.json': { state: 'working', step: '4', note: 'running the tester' }, 'run.log': log });
    makeSession('issue', 2, { pid: '2000000000', 'state.json': { state: 'done' }, 'run.log': 'all done\n' });
    makeSession('review', 5, { pid: '2000000000', 'run.log': 'died\n' });
    await reap();
    expect(exists(statePath('paused_until'))).toBe(false); // the limit line belongs to the previous run
    expect(exitsOf(sessionDir('issue', 1))).toMatchObject([{ how: 'the session ended on its own', step: '4', note: 'running the tester', tail: 'Out of time. Left: the UI.' }]);
    expect(exitsOf(sessionDir('issue', 2))).toEqual([]);
    expect(exitsOf(sessionDir('review', 5))).toEqual([]);
    expect(readLog().at(-1)).toMatch(/issue-1 ended without finishing — the session ended on its own at step 4 \(running the tester\)/);
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
