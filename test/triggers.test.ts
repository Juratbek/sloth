import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setDry } from '../server/runner/log';
import { handover, park, pickup, reap, retryStranded, reviews, stop } from '../server/runner/triggers';
import { exitsOf } from '../server/runner/exits';
import { qaVerdicts } from '../server/runner/qa';
import { sampleMachine, setReaders } from '../server/runner/machine';
import { resetSpawn, spawned } from './child-process-mock';
import { called, onGh, resetGh } from './gh-mock';
import { bootedAt } from '../server/runner/session-dirs';
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
    makeSession('issue', 3, { retries: '2', blocked: '1', 'state.json': { state: 'done' }, 'inbox/1.md': 'old', 'handoff.md': 'next: old note' });
    await pickup([card(3, 'Todo')]);
    expect(exists(sessionDir('issue', 3), 'retries')).toBe(false);
    expect(exists(sessionDir('issue', 3), 'blocked')).toBe(false);
    expect(exists(sessionDir('issue', 3), 'inbox', '1.md')).toBe(false);
    // A pickup is a start-over: the dead run's handoff note must not steer the fresh session.
    expect(exists(sessionDir('issue', 3), 'handoff.md')).toBe(false);
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
    makeSession('issue', 4, { 'handoff.md': 'next: fix the failing check' });
    await retryStranded([card(4, 'In Progress')]);
    expect(launches()).toEqual(['/sloth:implement 4']);
    expect(read(path.join(sessionDir('issue', 4), 'retries'))).toBe('1');
    // The relaunch keeps the dead run's handoff note — it is how the new run continues instead of re-deriving.
    expect(read(path.join(sessionDir('issue', 4), 'handoff.md'))).toBe('next: fix the failing check');
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

describe('qaVerdicts (handoff)', () => {
  it('a failed verdict clears the issue run leftovers, the handoff note among them', async () => {
    onGh(/project item-add/, 'ITEM');
    makeSession('qa', 7, { verdict: 'failed', sha: 'abcdef1' });
    makeSession('issue', 7, { retries: '1', blocked: '1', 'handoff.md': 'next: stale note' });
    await qaVerdicts();
    expect(called(/item-edit .*opt-wip/)).toHaveLength(1);
    expect(exists(sessionDir('issue', 7), 'retries')).toBe(false);
    expect(exists(sessionDir('issue', 7), 'blocked')).toBe(false);
    // The fresh implement run works from the QA findings on the issue, not the dead run's note.
    expect(exists(sessionDir('issue', 7), 'handoff.md')).toBe(false);
    expect(exists(sessionDir('qa', 7), 'handled')).toBe(true);
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
    // Four reviews in the one tick: the per-tick cap is `maxActive`, and this test is about the heads.
    configure({ maxActive: 4 });
    // A leftover final state from the previous head's run must not follow the new run into `reap`.
    makeSession('approved', 10, { 'state.json': { state: 'done' } });
    await reviews(board);
    expect(launches()).toEqual(['/sloth:review 10 final', '/sloth:review 11 final', '/sloth:review 12 final', '/sloth:review 13 final']);
    expect(spawned[0].options.env.SLOTH_PR).toBe('10');
    expect(spawned[0].args).toContain('fable');
    expect(read(path.join(sessionDir('approved', 10), 'issue'))).toBe('1');
    expect(exists(sessionDir('approved', 10), 'state.json')).toBe(false);
    expect(exists(statePath('approved', '10-aaa'))).toBe(true);
    expect(called(/item-edit/)).toHaveLength(0);
    resetSpawn();
    await reviews(board);
    expect(launches()).toEqual([]);
  });
  it('starts at most maxActive reviews in a tick, marks none of the rest, and takes them next tick', async () => {
    configure({ maxActive: 2 });
    wired({ 1: [{ pr: 10, sha: 'aaa', head: 'a' }], 2: [{ pr: 11, sha: 'bbb', head: 'b' }], 3: [{ pr: 12, sha: 'ccc', head: 'c' }] });
    const board = [card(1, 'Code Review'), card(2, 'Code Review'), card(3, 'Code Review')];
    await reviews(board);
    expect(launches()).toEqual(['/sloth:review 10 final', '/sloth:review 11 final']);
    // The one that waited kept its turn: no marker, so the next tick — on a fresh machine reading — takes it.
    expect(exists(statePath('approved', '12-ccc'))).toBe(false);
    expect(readLog().at(-1)).toMatch(/review PR #12 waits for the next tick \(2 reviews started in this one\)/);
    resetSpawn();
    await reviews(board);
    expect(launches()).toEqual(['/sloth:review 12 final']);
    expect(exists(statePath('approved', '12-ccc'))).toBe(true);
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
  it('counts the reviews of one head that died without a verdict, and gives the head up after maxRetries', async () => {
    configure({ maxRetries: 2 });
    wired({ 1: [{ pr: 10, sha: 'aaa', head: 'x' }] });
    const board = [card(1, 'Code Review')];
    // Each round is a review that died: `reap` clears the head's marker, so the trigger comes straight back.
    for (const round of [1, 2, 3]) {
      resetSpawn();
      await reviews(board);
      expect(launches()).toEqual(['/sloth:review 10 final']);
      expect(read(path.join(sessionDir('approved', 10), 'retries'))).toBe(String(round));
      fs.rmSync(statePath('approved', '10-aaa'), { force: true });
    }
    resetSpawn();
    await reviews(board);
    expect(launches()).toEqual([]);
    expect(exists(statePath('approved', '10-aaa'))).toBe(true);
    expect(readLog().join('\n')).toMatch(/review PR #10 given up: it ended without a verdict 3 times on aaa/);
    expect(called(/item-edit .*opt-help/)).toHaveLength(1);
  });

  it('starts the count over when the PR is pushed to — a new head is a new review', async () => {
    configure({ maxRetries: 2 });
    wired({ 1: [{ pr: 10, sha: 'aaa', head: 'x' }] });
    await reviews([card(1, 'Code Review')]);
    expect(read(path.join(sessionDir('approved', 10), 'retries'))).toBe('1');
    resetGh();
    resetSpawn();
    wired({ 1: [{ pr: 10, sha: 'bbb', head: 'x' }] });
    await reviews([card(1, 'Code Review')]);
    expect(launches()).toEqual(['/sloth:review 10 final']);
    expect(read(path.join(sessionDir('approved', 10), 'retries'))).toBe('1');
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
  it('leaves a Sloth: skip card alone — a human owns it and does not need telling', async () => {
    passed(10, 'aaa');
    wired({ 1: [{ pr: 10, sha: 'aaa', head: 'x' }] });
    await handover([card(1, 'Approved', { labels: ['Fable: approved', 'Sloth: skip'] })]);
    expect(called(/issue comment/)).toHaveLength(0);
    expect(exists(statePath('handed', '10-aaa'))).toBe(false);
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
    makeSession('review', 5, { pid: '2000000000', 'state.json': { state: 'done' }, 'run.log': 'all good\n' });
    fs.mkdirSync(statePath('reviewed'), { recursive: true });
    fs.writeFileSync(statePath('reviewed', '5-abc'), '');
    await reap();
    expect(exists(sessionDir('issue', 1), 'pid')).toBe(false);
    expect(exists(sessionDir('review', 5), 'pid')).toBe(false);
    expect(Number(read(statePath('paused_until')))).toBeGreaterThan(Date.now() / 1000 + 1700);
    // The review finished before it died, so its head stays reviewed.
    expect(exists(statePath('reviewed', '5-abc'))).toBe(true);
  });
  it('clears the retry count of a run that reached done, and keeps a working or waiting one’s', async () => {
    // `retries` counts relaunches that finished nothing. A card that comes back from a failing review is
    // relaunched and counted too, so three honest round-trips used to park it saying the run "stopped
    // without finishing 2 times in a row" — with no record of any run to show for it.
    makeSession('issue', 1, { pid: '2000000000', retries: '2', 'state.json': { state: 'done' }, 'run.log': 'PR pushed\n' });
    makeSession('issue', 2, { pid: '2000000000', retries: '2', 'state.json': { state: 'waiting' }, 'run.log': 'asked\n' });
    makeSession('issue', 3, { pid: '2000000000', retries: '2', 'state.json': { state: 'working' }, 'run.log': 'died\n' });
    await reap();
    expect(exists(sessionDir('issue', 1), 'retries')).toBe(false);
    expect(read(path.join(sessionDir('issue', 2), 'retries'))).toBe('2');
    expect(read(path.join(sessionDir('issue', 3), 'retries'))).toBe('2');
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
    const logged = readLog().join('\n');
    expect(logged).toMatch(/issue-1 ended without finishing — the session ended on its own at step 4 \(running the tester\)/);
    expect(logged).toMatch(/review-5 ended without a verdict — the head will be reviewed again/);
  });
  it('cleans up the servers, database and worktree of a run that died mid-way, working or on the limit', async () => {
    fs.mkdirSync(path.join(configure().worktreesDir, 'issue-1'), { recursive: true });
    makeSession('issue', 1, { pid: '2000000000', 'state.json': { state: 'working', servers: 'running' }, 'run.log': 'died\n', 'dev.pid': '2000000001\n', 'redis.pid': '2000000002\n', 'demo.db': 'sloth_1\n' });
    makeSession('issue', 2, { pid: '2000000000', 'run.log': 'Claude AI usage limit reached|123\n', 'demo.db': 'sloth_2\n' });
    makeSession('qa', 3, { pid: '2000000000', 'run.log': 'usage limit reached\n', 'demo.db': 'sloth_qa_3\n' });
    await reap();
    for (const n of [1, 2]) {
      expect(exists(sessionDir('issue', n), 'demo.db')).toBe(false);
      expect(exists(sessionDir('issue', n), 'dev.pid')).toBe(false);
      expect(exists(sessionDir('issue', n), 'redis.pid')).toBe(false);
    }
    expect(exists(sessionDir('qa', 3), 'demo.db')).toBe(false);
    expect(called(/dropdb --if-exists sloth_1$/)).toHaveLength(1);
    expect(called(/dropdb --if-exists sloth_2$/)).toHaveLength(1);
    expect(called(/dropdb --if-exists sloth_qa_3$/)).toHaveLength(1);
    expect(called(/worktree remove .*issue-1 --force/)).toHaveLength(1);
  });
  it('leaves the app of a dead run that handed a preview over to the preview trigger', async () => {
    makeSession('issue', 1, { pid: '2000000000', 'state.json': { state: 'working' }, 'run.log': 'died\n', 'demo.db': 'sloth_1\n', 'preview.json': { url: 'http://localhost:3000' } });
    makeSession('issue', 2, { pid: '2000000000', 'state.json': { state: 'done', servers: 'preview' }, 'run.log': 'done\n', 'demo.db': 'sloth_2\n' });
    await reap();
    expect(exists(sessionDir('issue', 1), 'demo.db')).toBe(true);
    expect(exists(sessionDir('issue', 2), 'demo.db')).toBe(true);
    expect(called(/dropdb/)).toHaveLength(0);
  });
  it('drops the review marker when a review died on the limit, so the head is reviewed again', async () => {
    makeSession('review', 5, { pid: '2000000000', 'run.log': 'usage limit reached\n' });
    fs.mkdirSync(statePath('reviewed'), { recursive: true });
    fs.writeFileSync(statePath('reviewed', '5-abc'), '');
    await reap();
    expect(exists(statePath('reviewed', '5-abc'))).toBe(false);
  });
  it('drops the review marker when a review died without a verdict, and keeps a finished review’s', async () => {
    makeSession('review', 5, { pid: '2000000000', 'run.log': 'died mid-run\n' });
    makeSession('review', 6, { pid: '2000000000', 'state.json': { state: 'done' }, 'run.log': 'verdict posted\n' });
    fs.mkdirSync(statePath('reviewed'), { recursive: true });
    fs.writeFileSync(statePath('reviewed', '5-abc'), '');
    fs.writeFileSync(statePath('reviewed', '6-def'), '');
    await reap();
    expect(exists(statePath('reviewed', '5-abc'))).toBe(false);
    expect(exists(statePath('reviewed', '6-def'))).toBe(true);
    expect(exists(statePath('paused_until'))).toBe(false);
  });
  it('parks the issue behind a review that hung past its budget, so its card does not sit in Code Review', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      // `launchApproved` writes the issue beside the run; the head keeps its marker, so nothing here
      // would ever review it again and the card would wait in Code Review for a push that never comes.
      makeSession('approved', 30, { pid: '12345', issue: '12', 'state.json': { state: 'working', since: 1 } });
      fs.mkdirSync(statePath('approved'), { recursive: true });
      fs.writeFileSync(statePath('approved', '30-abc'), '');
      onGh(/project item-add/, 'ITEM');
      await reap();
      expect(exists(statePath('approved', '30-abc'))).toBe(true);
      expect(called(/issue comment 12 [\s\S]*the review of PR #30 was stopped: hung past the budget\./)).toHaveLength(1);
      expect(called(/item-edit .*opt-help/)).toHaveLength(1);
    } finally {
      kill.mockRestore();
    }
  });
  it('does not signal the pids of a run whose servers went down with the machine', async () => {
    // Liveness probes fail, so the run reads as dead and is swept; the teardown's own signals are recorded.
    const kill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal === 0) throw new Error('ESRCH');
      return true;
    });
    try {
      makeSession('issue', 1, { pid: '2000000000', 'state.json': { state: 'working' }, 'run.log': 'died\n', 'dev.pid': '4242\n', 'redis.pid': '4243\n' });
      // `dev.pid` predates the last boot: 4242 is whatever the kernel handed the number to since, and
      // signalling its process group is signalling a stranger's. `redis.pid` is this boot's and is not.
      const before = new Date((bootedAt() - 60) * 1000);
      fs.utimesSync(path.join(sessionDir('issue', 1), 'dev.pid'), before, before);
      await reap();
      const signalled = kill.mock.calls.filter(([, sig]) => sig !== 0).map(([pid]) => pid);
      expect(signalled).not.toContain(4242);
      expect(signalled).not.toContain(-4242);
      expect(signalled).toContain(4243);
      expect(readLog().join('\n')).toMatch(/issue-1: dev\.pid was written before the last boot/);
    } finally {
      kill.mockRestore();
    }
  });
  it('drops the QA head marker when a hung QA run is killed, and keeps a hung review’s', async () => {
    // Kills are stubbed out so the "live" hung sessions can be killed without taking the test down with them.
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      makeSession('qa', 9, { pid: '12345', 'state.json': { state: 'working', since: 1 } });
      makeSession('review', 5, { pid: '12346', 'state.json': { state: 'working', since: 1 } });
      fs.mkdirSync(statePath('qa'), { recursive: true });
      fs.writeFileSync(statePath('qa', '9-abc'), '');
      fs.mkdirSync(statePath('reviewed'), { recursive: true });
      fs.writeFileSync(statePath('reviewed', '5-abc'), '');
      await reap();
      expect(exists(statePath('qa', '9-abc'))).toBe(false);
      expect(exists(statePath('reviewed', '5-abc'))).toBe(true);
      const logged = readLog().join('\n');
      expect(logged).toMatch(/QA #9 stopped: hung past the budget/);
      expect(logged).toMatch(/QA #9 will be tested again/);
    } finally {
      kill.mockRestore();
    }
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
  it('parks the issue behind a review stopped from the monitor: nothing will review that head again', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      makeSession('approved', 30, { pid: '12345', issue: '12', 'state.json': { state: 'working' } });
      onGh(/project item-add/, 'ITEM');
      expect(await stop('approved', 30, 'stopped from the monitor', 'why')).toBe(true);
      expect(called(/issue comment 12 [\s\S]*the review of PR #30 was stopped: stopped from the monitor\./)).toHaveLength(1);
      expect(called(/item-edit .*opt-help/)).toHaveLength(1);
    } finally {
      kill.mockRestore();
    }
  });
  it('leaves the card where it is when the run records no issue, and says so', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      makeSession('review', 8, { pid: '12345' });
      expect(await stop('review', 8, 'stopped from the monitor', 'why')).toBe(true);
      expect(called(/issue comment/)).toHaveLength(0);
      expect(readLog().at(-1)).toMatch(/review PR #8: no issue recorded beside the run/);
    } finally {
      kill.mockRestore();
    }
  });
  it('has nothing to end for a dead working run or a dead review', async () => {
    makeSession('issue', 7, { pid: '2000000000', 'state.json': { state: 'working' } });
    makeSession('review', 8, { pid: '2000000000' });
    expect(await stop('issue', 7, 'x', 'y')).toBe(false);
    expect(await stop('review', 8, 'x', 'y')).toBe(false);
  });
});
