import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setDry } from '../server/runner/log';
import { handover, park, pickup, reap, retryStranded, reviews, stop } from '../server/runner/triggers';
import { exitsOf } from '../server/runner/exits';
import { sampleMachine, setReaders } from '../server/runner/machine';
import { resetSpawn, spawned } from './child-process-mock';
import { called, onGh, resetGh } from './gh-mock';
import { COLUMNS, alivePid, calmMachine, card, configure, exists, makeSession, read, readLog, sessionDir, statePath, wipe } from './harness';

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
  it("reviews every Code Review card's PR once per head — Sloth's own, a human's, skipped, GitHub-approved or a draft — on the final model", async () => {
    wired({
      1: [{ pr: 10, sha: 'aaa', head: 'sloth/issue-1-fix' }],
      2: [{ pr: 11, sha: 'bbb', head: 'feature/x', approved: true }],
      3: [{ pr: 12, sha: 'ccc', head: 'sloth/issue-3-y' }],
      4: [{ pr: 13, sha: 'ddd', head: 'wip', draft: true }],
    });
    const board = [card(1, 'Code Review'), card(2, 'Code Review'), card(3, 'Code Review', { labels: ['Sloth: skip'] }), card(4, 'Code Review')];
    await reviews(board);
    expect(launches()).toEqual(['/sloth:review 10 final', '/sloth:review 11 final', '/sloth:review 12 final', '/sloth:review 13 final']);
    expect(spawned[0].options.env.SLOTH_PR).toBe('10');
    expect(spawned[0].args).toContain('fable');
    expect(read(path.join(sessionDir('approved', 10), 'issue'))).toBe('1');
    expect(exists(statePath('approved', '10-aaa'))).toBe(true);
    expect(called(/item-edit/)).toHaveLength(0);
    resetSpawn();
    await reviews(board);
    expect(launches()).toEqual([]);
  });
  it('starts with every slot taken — the caps hold the builds, not the review — but not on a loaded machine', async () => {
    for (const n of [1, 2, 3]) makeSession('issue', n, { pid: alivePid() });
    wired({ 5: [{ pr: 10, sha: 'aaa', head: 'x' }] });
    await reviews([card(5, 'Code Review')]);
    expect(launches()).toEqual(['/sloth:review 10 final']);
    expect(exists(statePath('approved', '10-aaa'))).toBe(true);
    // The three builds are still alive, so a pickup keeps waiting where the review did not.
    resetSpawn();
    await pickup([card(6, 'Todo')]);
    expect(launches()).toEqual([]);
    expect(readLog().at(-1)).toMatch(/#6 queued \(slots full\)/);
    setReaders({ memoryFree: () => 7, cpuTimes: () => ({ idle: 0, total: 0 }), diskTimes: () => ({ busy: {}, total: 0 }), windowMs: 0 });
    await sampleMachine();
    resetGh();
    wired({ 7: [{ pr: 11, sha: 'bbb', head: 'y' }] });
    await reviews([card(7, 'Code Review')]);
    expect(launches()).toEqual([]);
    expect(exists(statePath('approved', '11-bbb'))).toBe(false);
    expect(readLog().at(-1)).toMatch(/review PR #11 queued \(machine busy: 7% memory free, under 10%\)/);
    calmMachine();
    await sampleMachine();
  });
  it('runs on models.final, and marks nothing in a dry run', async () => {
    configure({ models: { final: 'sonnet' } });
    wired({ 1: [{ pr: 10, sha: 'aaa', head: 'feature/x' }] });
    setDry(true);
    await reviews([card(1, 'Code Review')]);
    expect(exists(statePath('approved', '10-aaa'))).toBe(false);
    expect(readLog().at(-1)).toMatch(/dry-run: would review PR #10 \(issue #1\) on sonnet/);
  });
  it('waits out a pending check and leaves a red one to trigger 7', async () => {
    wired({ 1: [{ pr: 10, sha: 'aaa', head: 'x', checks: 'PENDING' }], 2: [{ pr: 11, sha: 'bbb', head: 'y', checks: 'FAILURE' }] });
    await reviews([card(1, 'Code Review'), card(2, 'Code Review')]);
    expect(launches()).toEqual([]);
    expect(exists(statePath('approved', '10-aaa'))).toBe(false);
    expect(readLog().join('\n')).toMatch(/review PR #10 waits for its checks/);
  });
  it('sends an Approved card whose head moved after the pass back to Code Review, label gone, and reviews it', async () => {
    fs.mkdirSync(statePath('approved'), { recursive: true });
    fs.writeFileSync(statePath('approved', '10-old'), '');
    onGh(/project item-add/, 'ITEM');
    wired({ 1: [{ pr: 10, sha: 'new', head: 'x' }] });
    const board = [card(1, 'Approved', { labels: ['Fable: approved'] })];
    await reviews(board);
    expect(called(/issue edit 1 .*--remove-label Fable: approved/)).toHaveLength(1);
    expect(called(/item-edit .*opt-review/)).toHaveLength(1);
    expect(launches()).toEqual(['/sloth:review 10 final']);
    expect(readLog().join('\n')).toMatch(/#1 back to Code Review: PR #10 head new has not been reviewed/);
    resetSpawn();
    await reviews(board);
    expect(launches()).toEqual([]);
  });
  it('leaves an Approved card alone when its head passed, and when a session is already on the issue', async () => {
    fs.mkdirSync(statePath('approved'), { recursive: true });
    fs.writeFileSync(statePath('approved', '10-aaa'), '');
    makeSession('issue', 2, { pid: alivePid() });
    wired({ 1: [{ pr: 10, sha: 'aaa', head: 'x' }], 2: [{ pr: 11, sha: 'bbb', head: 'sloth/issue-2-x' }] });
    await reviews([card(1, 'Approved', { labels: ['Fable: approved'] }), card(2, 'Approved', { labels: ['Fable: approved'] })]);
    expect(launches()).toEqual([]);
    expect(called(/item-edit|issue edit/)).toHaveLength(0);
  });
  it('still reviews Code Review without an Approved column', async () => {
    configure({ statusField: { id: 'PVTSSF_1', columns: { ...COLUMNS, approved: { id: '', name: '' } } } });
    wired({ 1: [{ pr: 10, sha: 'aaa', head: 'x' }] });
    await reviews([card(1, 'Code Review'), card(2, 'Approved')]);
    expect(launches()).toEqual(['/sloth:review 10 final']);
    expect(spawned[0].options.env.SLOTH_COL_APPROVED_ID).toBe('');
  });
});

describe('handover (trigger 5)', () => {
  const passed = (pr: number, sha: string) => {
    fs.mkdirSync(statePath('approved'), { recursive: true });
    fs.writeFileSync(statePath('approved', `${pr}-${sha}`), '');
  };
  const preview = (issue: number, url?: string) =>
    makeSession('issue', issue, { 'preview-state.json': { issue, key: 'k3y', startedAt: 0, expiresAt: 0, ...(url ? { url } : {}) } });

  it('tells the issue once per passed head that it is ready to test, with the preview link', async () => {
    passed(10, 'aaa');
    preview(1, 'https://p.example');
    wired({ 1: [{ pr: 10, sha: 'aaa', head: 'sloth/issue-1-x' }] });
    const board = [card(1, 'Approved', { labels: ['Fable: approved'] })];
    await handover(board);
    const [c] = called(/issue comment 1 /);
    expect(c.line).toMatch(/PR #10 passed the review — the card is in \*\*Approved\*\*, ready for a human to test/);
    expect(c.line).toContain('Test it here: https://p.example/?sloth_key=k3y');
    expect(exists(statePath('handed', '10-aaa'))).toBe(true);
    await handover(board);
    expect(called(/issue comment/)).toHaveLength(1);
  });
  it('points at the PR when there is no preview, and at a link that has not been printed yet only later', async () => {
    passed(11, 'bbb');
    passed(12, 'ccc');
    preview(2);
    wired({ 2: [{ pr: 11, sha: 'bbb', head: 'sloth/issue-2-x' }], 3: [{ pr: 12, sha: 'ccc', head: 'feature/x' }] });
    await handover([card(2, 'Approved', { labels: ['Fable: approved'] }), card(3, 'Approved', { labels: ['Fable: approved'] })]);
    expect(called(/issue comment 2 [\s\S]*No preview for this one — check the PR out to test it: https:\/\/github.com\/acme\/widgets\/pull\/11/)).toHaveLength(1);
    expect(called(/issue comment 3 [\s\S]*https:\/\/github.com\/acme\/widgets\/pull\/12/)).toHaveLength(1);
  });
  it('waits for the label, the pass marker of the current head and the review to end', async () => {
    passed(10, 'old');
    passed(13, 'ddd');
    makeSession('approved', 13, { pid: alivePid() });
    wired({ 1: [{ pr: 10, sha: 'new', head: 'x' }], 4: [{ pr: 13, sha: 'ddd', head: 'y' }], 5: [{ pr: 14, sha: 'eee', head: 'z' }] });
    await handover([card(1, 'Approved', { labels: ['Fable: approved'] }), card(4, 'Approved', { labels: ['Fable: approved'] }), card(5, 'Approved')]);
    expect(called(/issue comment/)).toHaveLength(0);
    expect(fs.existsSync(statePath('handed'))).toBe(false);
  });
  it('only logs in a dry run, and does nothing without an Approved column', async () => {
    passed(10, 'aaa');
    wired({ 1: [{ pr: 10, sha: 'aaa', head: 'x' }] });
    setDry(true);
    await handover([card(1, 'Approved', { labels: ['Fable: approved'] })]);
    expect(called(/issue comment/)).toHaveLength(0);
    expect(exists(statePath('handed', '10-aaa'))).toBe(false);
    expect(readLog().at(-1)).toMatch(/dry-run: would tell #1 it is ready to test/);
    setDry(false);
    resetGh();
    configure({ statusField: { id: 'PVTSSF_1', columns: { ...COLUMNS, approved: { id: '', name: '' } } } });
    await handover([card(1, 'Approved', { labels: ['Fable: approved'] })]);
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
