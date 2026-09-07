import fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { autoMerge, conflicts, failedChecks, finished } from '../server/runner/lifecycle';
import { setDry } from '../server/runner/log';
import { resetSpawn, spawned } from './child-process-mock';
import { called, fail, onGh, resetGh } from './gh-mock';
import { COLUMNS, alivePid, card, configure, exists, makeSession, readLog, statePath, wipe } from './harness';

vi.mock('../server/runner/gh', () => import('./gh-mock'));
vi.mock('node:child_process', () => import('./child-process-mock'));

interface Pr {
  pr: number;
  sha: string;
  head: string;
  state?: 'OPEN' | 'MERGED' | 'CLOSED';
  checks?: string;
  mergeable?: string;
  draft?: boolean;
}

/** Answers the wired-PR query with the PRs of the issues that query actually asked about. */
const wired = (prs: Record<number, Pr[]>) =>
  onGh(/closedByPullRequestsReferences/, ({ line }) => ({
    data: {
      repository: Object.fromEntries(
        Object.entries(prs)
          .filter(([issue]) => line.includes(`i${issue}: issue(number: ${issue})`))
          .map(([issue, list]) => [
            `i${issue}`,
            {
              closedByPullRequestsReferences: {
                nodes: list.map((p) => ({
                  number: p.pr,
                  state: p.state ?? 'OPEN',
                  isDraft: !!p.draft,
                  headRefOid: p.sha,
                  headRefName: p.head,
                  baseRefName: 'main',
                  reviewDecision: null,
                  mergeable: p.mergeable ?? 'MERGEABLE',
                  ...(p.checks ? { commits: { nodes: [{ commit: { statusCheckRollup: { state: p.checks } } }] } } : {}),
                })),
              },
            },
          ]),
      ),
    },
  }));

const launches = () => spawned.map((s) => s.args[1]);
const marker = (dir: string, name: string) => fs.writeFileSync(statePath(dir, name), '');

beforeEach(() => {
  configure({ maxActive: 2, maxAlive: 3 });
  wipe();
  resetGh();
  resetSpawn();
  setDry(false);
  for (const dir of ['approved', 'finished', 'checks', 'conflicts', 'closed', 'merged', 'merge-failed']) fs.mkdirSync(statePath(dir), { recursive: true });
});

describe('finished (trigger 6)', () => {
  it("moves a closed issue's card to Done, cleans the run up and deletes its own branch", async () => {
    onGh(/project item-add/, 'ITEM');
    wired({ 1: [{ pr: 10, sha: 'aaa', head: 'sloth/issue-1-fix', state: 'MERGED' }] });
    await finished([card(1, COLUMNS.codeReview.name, { closed: true })]);
    expect(called(/item-edit .*opt-done/)).toHaveLength(1);
    expect(called(/api -X DELETE repos\/acme\/widgets\/git\/refs\/heads\/sloth\/issue-1-fix/)).toHaveLength(1);
    expect(exists(statePath('finished', '1'))).toBe(true);
  });

  it('files a closed card away from the pickup column too, so nothing picks it up', async () => {
    // The pickup column was not a worked column, so a closed card left there was never filed — and
    // `pickup` had no `closed` filter of its own: it spent a slot and an hour implementing a duplicate.
    onGh(/project item-add/, 'ITEM');
    wired({ 5: [] });
    await finished([card(5, COLUMNS.pickup.name, { closed: true })]);
    expect(called(/item-edit .*opt-done/)).toHaveLength(1);
    expect(exists(statePath('finished', '5'))).toBe(true);
  });

  it('leaves a human branch alone, files the card once, and forgets a re-opened issue', async () => {
    configure({ statusField: { id: 'PVTSSF_1', columns: { ...COLUMNS, done: { id: '', name: '' } } } });
    wired({ 2: [{ pr: 11, sha: 'bbb', head: 'feature/x', state: 'MERGED' }] });
    const closed = [card(2, COLUMNS.approved.name, { closed: true })];
    await finished(closed);
    expect(called(/DELETE/)).toHaveLength(0);
    expect(exists(statePath('finished', '2'))).toBe(true);
    resetGh();
    wired({ 2: [{ pr: 11, sha: 'bbb', head: 'feature/x', state: 'MERGED' }] });
    await finished(closed);
    expect(called(/graphql/)).toHaveLength(0);
    await finished([card(2, COLUMNS.approved.name)]);
    expect(exists(statePath('finished', '2'))).toBe(false);
  });

  it('says a branch was already gone when GitHub 422s, and skips cards outside its columns', async () => {
    onGh(/git\/refs\/heads/, fail('HTTP 422: Reference does not exist'));
    wired({ 3: [{ pr: 12, sha: 'ccc', head: 'sloth/issue-3-x', state: 'MERGED' }] });
    await finished([card(3, COLUMNS.inProgress.name, { closed: true }), card(4, 'Backlog', { closed: true })]);
    expect(readLog().join('\n')).toMatch(/branch sloth\/issue-3-x was already gone/);
    expect(exists(statePath('finished', '4'))).toBe(false);
  });

  it('parks a card whose PR was closed unmerged, once per PR', async () => {
    wired({ 5: [{ pr: 13, sha: 'ddd', head: 'sloth/issue-5-x', state: 'CLOSED' }] });
    const board = [card(5, COLUMNS.codeReview.name)];
    await finished(board);
    expect(called(/issue comment 5 .*PR #13 was closed without being merged/)).toHaveLength(1);
    expect(called(/item-edit .*opt-help/)).toHaveLength(1);
    expect(exists(statePath('closed', '13'))).toBe(true);
    resetGh();
    wired({ 5: [{ pr: 13, sha: 'ddd', head: 'sloth/issue-5-x', state: 'CLOSED' }] });
    await finished(board);
    expect(called(/issue comment/)).toHaveLength(0);
  });

  it('leaves the card alone while another PR is open, a session runs or a human owns it', async () => {
    makeSession('issue', 7, { pid: alivePid() });
    wired({
      6: [{ pr: 14, sha: 'e', head: 'sloth/issue-6-x', state: 'CLOSED' }, { pr: 15, sha: 'f', head: 'sloth/issue-6-y' }],
      7: [{ pr: 16, sha: 'g', head: 'sloth/issue-7-x', state: 'CLOSED' }],
      8: [{ pr: 17, sha: 'h', head: 'sloth/issue-8-x', state: 'CLOSED' }],
    });
    await finished([card(6, COLUMNS.codeReview.name), card(7, COLUMNS.codeReview.name), card(8, COLUMNS.approved.name, { labels: ['Sloth: skip'] })]);
    expect(called(/issue comment/)).toHaveLength(0);
  });

  it('only logs in a dry run', async () => {
    setDry(true);
    wired({ 9: [{ pr: 18, sha: 'iii', head: 'sloth/issue-9-x', state: 'MERGED' }] });
    await finished([card(9, COLUMNS.codeReview.name, { closed: true })]);
    expect(called(/item-add|DELETE/)).toHaveLength(0);
    expect(exists(statePath('finished', '9'))).toBe(false);
    expect(readLog().join('\n')).toMatch(/dry-run: would delete branch sloth\/issue-9-x/);
  });
});

describe('failedChecks (trigger 7)', () => {
  it("sends the session back to its own PR once per head, dropping the approval label", async () => {
    wired({ 1: [{ pr: 10, sha: 'abcdef1234', head: 'sloth/issue-1-x', checks: 'FAILURE' }] });
    const board = [card(1, COLUMNS.approved.name, { labels: ['Fable: approved'] })];
    await failedChecks(board);
    expect(called(/issue edit 1 .*--remove-label Fable: approved/)).toHaveLength(1);
    expect(launches()).toEqual([
      '/sloth:implement 1 The checks on PR #10 fail on commit abcdef1: this is a review round-trip — check the branch out, make the checks pass, push, keep the PR.',
    ]);
    expect(called(/item-edit .*opt-wip/)).toHaveLength(1);
    expect(exists(statePath('checks', '10-abcdef1234'))).toBe(true);
    resetSpawn();
    await failedChecks(board);
    expect(launches()).toEqual([]);
  });

  it("leaves a human's PR, a green head, a skipped card and a live session alone", async () => {
    makeSession('issue', 4, { pid: alivePid() });
    wired({
      1: [{ pr: 10, sha: 'a', head: 'feature/x', checks: 'FAILURE' }],
      2: [{ pr: 11, sha: 'b', head: 'sloth/issue-2-x', checks: 'SUCCESS' }],
      4: [{ pr: 13, sha: 'd', head: 'sloth/issue-4-x', checks: 'FAILURE' }],
    });
    await failedChecks([
      card(1, COLUMNS.codeReview.name),
      card(2, COLUMNS.codeReview.name),
      card(3, COLUMNS.codeReview.name, { labels: ['Sloth: skip'] }),
      card(4, COLUMNS.approved.name),
    ]);
    expect(launches()).toEqual([]);
  });

  it('waits while the review of the same PR is still reading it', async () => {
    // Every other wired-PR trigger guards against a live review; this one did not. A slow check turning red
    // on a head the reviewer had already started on launched a session that pushed a new head, while the
    // review posted its verdict on the old one and moved the card by it — the two-actor race the other
    // triggers document as closed.
    makeSession('approved', 10, { pid: alivePid(), issue: '1' });
    wired({ 1: [{ pr: 10, sha: 'aaa', head: 'sloth/issue-1-x', checks: 'FAILURE' }] });
    await failedChecks([card(1, COLUMNS.codeReview.name)]);
    expect(launches()).toEqual([]);
    expect(exists(statePath('checks', '10-aaa'))).toBe(false);
  });

  it('only logs in a dry run', async () => {
    setDry(true);
    wired({ 1: [{ pr: 10, sha: 'aaa', head: 'sloth/issue-1-x', checks: 'FAILURE' }] });
    await failedChecks([card(1, COLUMNS.codeReview.name)]);
    expect(launches()).toEqual([]);
    expect(exists(statePath('checks', '10-aaa'))).toBe(false);
    expect(readLog().at(-1)).toMatch(/dry-run: would launch #1 \(The checks on PR #10 fail/);
  });
});

describe('conflicts (trigger 10)', () => {
  const ORDER =
    '/sloth:implement 1 PR #10 conflicts with its base on commit abcdef1: this is a review round-trip — check the branch out, ' +
    'merge `origin/main` into it, resolve every conflict keeping what both sides meant, make the checks pass, push, keep the PR. ' +
    'Merge only: never rebase, never force-push.';

  it('does nothing until the setting is on', async () => {
    wired({ 1: [{ pr: 10, sha: 'abcdef1234', head: 'sloth/issue-1-x', mergeable: 'CONFLICTING' }] });
    await conflicts([card(1, COLUMNS.codeReview.name)]);
    expect(launches()).toEqual([]);
    expect(called(/closedByPullRequestsReferences/)).toHaveLength(0);
  });

  it('sends the session back to a conflicting Code Review PR once per head, naming the base', async () => {
    configure({ resolveConflicts: true });
    wired({ 1: [{ pr: 10, sha: 'abcdef1234', head: 'sloth/issue-1-x', mergeable: 'CONFLICTING' }] });
    const board = [card(1, COLUMNS.codeReview.name)];
    await conflicts(board);
    expect(launches()).toEqual([ORDER]);
    expect(called(/item-edit .*opt-wip/)).toHaveLength(1);
    expect(exists(statePath('conflicts', '10-abcdef1234'))).toBe(true);
    resetSpawn();
    await conflicts(board);
    expect(launches()).toEqual([]);
  });

  it('tries a new head again — the base moved once more — but not the same one', async () => {
    configure({ resolveConflicts: true });
    marker('conflicts', '10-old');
    wired({ 1: [{ pr: 10, sha: 'new', head: 'sloth/issue-1-x', mergeable: 'CONFLICTING' }] });
    await conflicts([card(1, COLUMNS.codeReview.name)]);
    expect(launches()).toHaveLength(1);
    expect(exists(statePath('conflicts', '10-new'))).toBe(true);
  });

  it("leaves a human's PR, a mergeable or unknown head, a skipped card, an Approved card, a live session and a running review alone", async () => {
    configure({ resolveConflicts: true });
    makeSession('issue', 5, { pid: alivePid() });
    makeSession('approved', 16, { pid: alivePid() });
    wired({
      1: [{ pr: 10, sha: 'a', head: 'feature/x', mergeable: 'CONFLICTING' }],
      2: [{ pr: 11, sha: 'b', head: 'sloth/issue-2-x', mergeable: 'MERGEABLE' }],
      3: [{ pr: 12, sha: 'c', head: 'sloth/issue-3-x', mergeable: 'UNKNOWN' }],
      4: [{ pr: 13, sha: 'd', head: 'sloth/issue-4-x', mergeable: 'CONFLICTING' }],
      5: [{ pr: 14, sha: 'e', head: 'sloth/issue-5-x', mergeable: 'CONFLICTING' }],
      6: [{ pr: 15, sha: 'f', head: 'sloth/issue-6-x', mergeable: 'CONFLICTING' }],
      7: [{ pr: 16, sha: 'g', head: 'sloth/issue-7-x', mergeable: 'CONFLICTING' }],
    });
    await conflicts([
      card(1, COLUMNS.codeReview.name),
      card(2, COLUMNS.codeReview.name),
      card(3, COLUMNS.codeReview.name),
      card(4, COLUMNS.codeReview.name, { labels: ['Sloth: skip'] }),
      card(5, COLUMNS.codeReview.name),
      card(6, COLUMNS.approved.name, { labels: ['Fable: approved'] }),
      card(7, COLUMNS.codeReview.name),
    ]);
    expect(launches()).toEqual([]);
    expect(fs.readdirSync(statePath('conflicts'))).toEqual([]);
  });

  it('only logs in a dry run', async () => {
    configure({ resolveConflicts: true });
    setDry(true);
    wired({ 1: [{ pr: 10, sha: 'aaa', head: 'sloth/issue-1-x', mergeable: 'CONFLICTING' }] });
    await conflicts([card(1, COLUMNS.codeReview.name)]);
    expect(launches()).toEqual([]);
    expect(exists(statePath('conflicts', '10-aaa'))).toBe(false);
    expect(readLog().at(-1)).toMatch(/dry-run: would launch #1 \(PR #10 conflicts with its base/);
  });
});

describe('autoMerge (trigger 8)', () => {
  const approvedCard = (n: number) => card(n, COLUMNS.approved.name, { labels: ['Fable: approved'] });

  it('merges a PR that passed its final review on this very head', async () => {
    configure({ autoMerge: 'squash' });
    marker('approved', '20-aaa');
    wired({ 1: [{ pr: 20, sha: 'aaa', head: 'sloth/issue-1-x', checks: 'SUCCESS' }] });
    await autoMerge([approvedCard(1)]);
    expect(called(/pr merge 20 --repo acme\/widgets --squash/)).toHaveLength(1);
    expect(exists(statePath('merged', '20-aaa'))).toBe(true);
    await autoMerge([approvedCard(1)]);
    expect(called(/pr merge/)).toHaveLength(1);
  });

  it('never merges the PR of a Sloth: skip card, however well its review went', async () => {
    // Trigger 4 reviews a skipped card on purpose — the column is the signal there — and a pass labels it
    // and moves it here. Merging it would be the one place Sloth acts on a card a human took over.
    configure({ autoMerge: 'squash' });
    marker('approved', '28-hhh');
    wired({ 1: [{ pr: 28, sha: 'hhh', head: 'sloth/issue-1-x', checks: 'SUCCESS' }] });
    await autoMerge([card(1, COLUMNS.approved.name, { labels: ['Fable: approved', 'Sloth: skip'] })]);
    expect(called(/pr merge/)).toHaveLength(0);
    expect(exists(statePath('merged', '28-hhh'))).toBe(false);
  });

  it('does nothing without a method, without the label, or without a marker for this head', async () => {
    wired({ 1: [{ pr: 21, sha: 'aaa', head: 'sloth/issue-1-x', checks: 'NONE' }] });
    await autoMerge([approvedCard(1)]);
    expect(called(/graphql/)).toHaveLength(0);
    configure({ autoMerge: 'merge' });
    marker('approved', '21-old');
    await autoMerge([approvedCard(1), card(2, COLUMNS.approved.name)]);
    expect(called(/pr merge/)).toHaveLength(0);
  });

  it('holds a conflicting, failing or draft PR and says why once', async () => {
    configure({ autoMerge: 'rebase' });
    marker('approved', '22-bbb');
    marker('approved', '23-ccc');
    marker('approved', '27-ggg');
    wired({
      1: [{ pr: 22, sha: 'bbb', head: 'sloth/issue-1-x', checks: 'SUCCESS', mergeable: 'CONFLICTING' }],
      2: [{ pr: 23, sha: 'ccc', head: 'sloth/issue-2-x', checks: 'FAILURE' }],
      3: [{ pr: 27, sha: 'ggg', head: 'wip', checks: 'SUCCESS', draft: true }],
    });
    const board = [approvedCard(1), approvedCard(2), approvedCard(3)];
    await autoMerge(board);
    await autoMerge(board);
    expect(called(/pr merge/)).toHaveLength(0);
    expect(readLog().filter((l) => /PR #22 is not merged: it conflicts/.test(l))).toHaveLength(1);
    expect(readLog().filter((l) => /PR #23 is not merged: its checks fail/.test(l))).toHaveLength(1);
    expect(readLog().filter((l) => /PR #27 is not merged: it is still a draft/.test(l))).toHaveLength(1);
  });

  it('remembers a refused merge so it is not retried on the same head', async () => {
    configure({ autoMerge: 'squash' });
    marker('approved', '24-ddd');
    onGh(/pr merge/, fail('failed to merge: base branch was modified\nmore'));
    wired({ 1: [{ pr: 24, sha: 'ddd', head: 'sloth/issue-1-x', checks: 'SUCCESS' }] });
    await autoMerge([approvedCard(1)]);
    expect(exists(statePath('merge-failed', '24-ddd'))).toBe(true);
    expect(readLog().at(-1)).toMatch(/PR #24 merge failed: failed to merge: base branch was modified$/);
    await autoMerge([approvedCard(1)]);
    expect(called(/pr merge/)).toHaveLength(1);
  });

  it('waits for a running final review and only logs in a dry run', async () => {
    configure({ autoMerge: 'squash' });
    makeSession('approved', 25, { pid: alivePid() });
    marker('approved', '25-eee');
    marker('approved', '26-fff');
    wired({
      1: [{ pr: 25, sha: 'eee', head: 'sloth/issue-1-x', checks: 'SUCCESS' }],
      2: [{ pr: 26, sha: 'fff', head: 'sloth/issue-2-x', checks: 'SUCCESS' }],
    });
    setDry(true);
    await autoMerge([approvedCard(1), approvedCard(2)]);
    expect(called(/pr merge/)).toHaveLength(0);
    expect(exists(statePath('merged', '26-fff'))).toBe(false);
    expect(readLog().at(-1)).toMatch(/dry-run: would merge PR #26 \(--squash\)/);
  });
});
