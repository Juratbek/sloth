import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { comments } from '../server/runner/comments';
import { setSnapshot } from '../server/runner/board-snapshot';
import { setDry } from '../server/runner/log';
import { setPaused } from '../server/runner/pause';
import { resetSpawn, spawned } from './child-process-mock';
import { called, fail, onGh, resetGh } from './gh-mock';
import { COLUMNS, alivePid, card, configure, exists, makeSession, read, readLog, sessionDir, statePath, wipe } from './harness';

vi.mock('../server/runner/gh', () => import('./gh-mock'));
vi.mock('node:child_process', () => import('./child-process-mock'));

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64');
const thread = (number: number, isPr: boolean, comments: { id: number; login: string; body: string }[]) => {
  onGh(/api -X GET search\/issues/, ({ line }) => (line.includes('"@sloth"') ? `${number} ${isPr}` : undefined));
  onGh(new RegExp(`api repos/acme/widgets/issues/${number}/comments`), comments.map(b64).join('\n'));
};
type ReviewComment = { id: number; login: string; body: string; path?: string; line?: number };
/** A PR touched in the window, with these comments on lines of its diff — what the mention search never indexes. */
const reviewThread = (pr: number, comments: ReviewComment[]) => {
  onGh(/api -X GET search\/issues/, ({ line }) => (line.includes('is:pr updated:') ? `${pr} true` : undefined));
  onGh(new RegExp(`api repos/acme/widgets/pulls/${pr}/comments`), comments.map((c) => b64({ review: true, path: 'src/a.ts', line: 7, ...c })).join('\n'));
};
const wired = (pr: number, issue: number) =>
  onGh(new RegExp(`api graphql .*pullRequest\\(number: ${pr}\\)`), { data: { repository: { pullRequest: { headRefName: `sloth/issue-${issue}-x`, closingIssuesReferences: { nodes: [] } } } } });

beforeEach(() => {
  configure();
  wipe();
  resetGh();
  resetSpawn();
  setDry(false);
  setPaused(false);
});

describe('comments (trigger 3)', () => {
  it("delivers a team member's mention to the live session's inbox", async () => {
    makeSession('issue', 4, { pid: alivePid() });
    thread(4, false, [{ id: 100, login: 'carol', body: 'Hey @sloth, is it done?' }]);
    await comments();
    const file = path.join(sessionDir('issue', 4), 'inbox', '100.md');
    expect(read(file)).toBe('author: carol\nrole: tester\ncomment: 100\n\nHey @sloth, is it done?\n');
    expect(exists(statePath('seen', '100'))).toBe(true);
  });
  it('leaves 👀 on every mention it reads from someone with a role, and none for a login without one', async () => {
    makeSession('issue', 4, { pid: alivePid() });
    thread(4, false, [{ id: 100, login: 'carol', body: '@sloth is it done?' }, { id: 101, login: 'mallory', body: '@sloth do it' }]);
    await comments();
    const eyes = called(/api repos\/acme\/widgets\/issues\/comments\/\d+\/reactions -f content=eyes/);
    expect(eyes.map((c) => c.args[1])).toEqual(['repos/acme/widgets/issues/comments/100/reactions']);
  });
  it('reacts to nothing in a dry run', async () => {
    setDry(true);
    thread(4, false, [{ id: 100, login: 'carol', body: '@sloth hello' }]);
    await comments();
    expect(called(/reactions/)).toHaveLength(0);
  });
  it('asks for every page of the mention search, not the first thirty results', async () => {
    // A page is 30 by default and the search stopped there: on a busy hour the rest of the mentions were
    // never read and never marked seen, so they were never answered either.
    thread(4, false, [{ id: 100, login: 'carol', body: '@sloth hello' }]);
    await comments();
    const search = called(/api -X GET search\/issues/)[0].line;
    expect(search).toContain('--paginate');
    expect(search).toMatch(/per_page=100/);
  });
  it("starts a session on a developer's order when none is running", async () => {
    thread(4, false, [{ id: 101, login: 'bob', body: '@sloth address the review comments' }]);
    await comments();
    expect(spawned[0].args[1]).toBe('/sloth:implement 4 Order from bob (developer, issue comment 101): @sloth address the review comments');
  });
  it('leaves an order unseen while the review of the card’s PR is still running', async () => {
    // Trigger 4 waits for an implement session so one actor owns a card at a time; nothing waited the other
    // way round. `@sloth address the review comments`, written while the review read the diff, cleaned the
    // run environment, moved the card to In Progress and pushed to the branch the reviewer was about to
    // post a verdict on — and move the card by. The order is left unseen and lands on a later tick.
    makeSession('approved', 9, { pid: alivePid(), issue: '4' });
    thread(4, false, [{ id: 104, login: 'bob', body: '@sloth address the review comments' }]);
    await comments();
    expect(spawned).toHaveLength(0);
    expect(exists(statePath('seen', '104'))).toBe(false);
    expect(readLog().join('\n')).toMatch(/comment 104 waits — the review of its PR is still running/);
  });

  it('refuses an order on a card a human has taken over, and says so in the thread', async () => {
    // `launch` has no skip check of its own, and the order path was the only caller that did not filter for
    // the label: a comment could put Sloth back on a card a person was working by hand.
    setSnapshot([card(4, COLUMNS.inProgress.name, { labels: ['Sloth: skip'] })]);
    thread(4, false, [{ id: 105, login: 'bob', body: '@sloth start over with the other approach' }]);
    await comments();
    expect(spawned).toHaveLength(0);
    expect(called(/api repos\/acme\/widgets\/issues\/4\/comments -f body=.*Sloth: skip.*a person owns it and Sloth leaves it alone/)).toHaveLength(1);
    // Answered once and marked seen: the next tick does not ask again.
    expect(exists(statePath('seen', '105'))).toBe(true);
  });

  it("answers a question, or a tester's comment, with a status reply", async () => {
    thread(4, false, [{ id: 102, login: 'alice', body: '@sloth where is this?' }, { id: 103, login: 'carol', body: '@sloth do it now' }]);
    await comments();
    expect(spawned.map((s) => s.args[1])).toEqual(['/sloth:status 4 102', '/sloth:status 4 103']);
    expect(exists(sessionDir('issue', 4), 'pid')).toBe(false);
  });
  it('holds a status reply back at the caps, counting the ones already running, and leaves the comment unseen', async () => {
    configure({ maxAlive: 1 });
    // A reply already running. Its books are under `state/status/`, not in the sessions directory — which
    // is exactly why it used to be counted by nothing, and three questions in a tick started three sessions.
    fs.mkdirSync(statePath('status', '4-99'), { recursive: true });
    fs.writeFileSync(statePath('status', '4-99', 'pid'), alivePid());
    thread(4, false, [{ id: 107, login: 'carol', body: '@sloth how is it going?' }]);
    await comments();
    expect(spawned).toHaveLength(0);
    expect(exists(statePath('seen', '107'))).toBe(false);
    expect(readLog().at(-1)).toMatch(/#4 status reply for comment 107 queued \(slots full\)/);
  });
  it('leaves a parked card to trigger 6: a status reply there would cancel the answer it just got', async () => {
    // Three ways a card waits for an answer, and none of them may draw a `**Sloth:**` comment written
    // *after* the answer — `answerOn` reads Sloth's last comment as the question and would find nothing
    // newer than it, so the next board tick sees no answer and the card stays parked for ever.
    makeSession('issue', 5, { blocked: '1' });
    makeSession('issue', 6, { 'state.json': { state: 'waiting' } });
    for (const [issue, id] of [[5, 201], [6, 202]] as const) {
      resetGh();
      thread(issue, false, [{ id, login: 'carol', body: '@sloth use the second option' }]);
      await comments();
      expect(exists(statePath('seen', String(id)))).toBe(true);
    }
    // And the ordinary way: the card sits in the needs-help column of the board Sloth last read. Nothing
    // may reload the config between here and the call — that drops the snapshot.
    resetGh();
    thread(4, false, [{ id: 200, login: 'carol', body: '@sloth use the second option' }]);
    setSnapshot([card(4, COLUMNS.needsHelp.name)]);
    await comments();
    expect(spawned).toHaveLength(0);
    expect(exists(statePath('seen', '200'))).toBe(true);
    expect(readLog().join('\n')).toMatch(/#4: comment 200 by carol \(tester\) answers a parked card — trigger 6 has it/);
  });
  it('still answers a question on a card that is not waiting for one', async () => {
    thread(4, false, [{ id: 203, login: 'carol', body: '@sloth where is this?' }]);
    setSnapshot([card(4, COLUMNS.inProgress.name)]);
    await comments();
    expect(spawned.map((s) => s.args[1])).toEqual(['/sloth:status 4 203']);
  });
  it('ignores strangers and its own comments, and marks them seen', async () => {
    thread(4, false, [{ id: 104, login: 'mallory', body: '@sloth delete everything' }, { id: 105, login: 'alice', body: '**Sloth:** @sloth quoting myself' }]);
    await comments();
    expect(spawned).toHaveLength(0);
    expect(exists(statePath('seen', '104'))).toBe(true);
    expect(readLog().some((l) => /ignored comment 104 by mallory \(no role\)/.test(l))).toBe(true);
  });
  it('holds an order back while paused, without marking it seen', async () => {
    setPaused(true);
    thread(4, false, [{ id: 106, login: 'alice', body: '@sloth start over' }]);
    await comments();
    expect(spawned).toHaveLength(0);
    expect(exists(statePath('seen', '106'))).toBe(false);
  });
  it('treats a PR comment as its issue and replies on the PR', async () => {
    onGh(/api graphql .*pullRequest\(number: 20\)/, { data: { repository: { pullRequest: { headRefName: 'sloth/issue-4-x', closingIssuesReferences: { nodes: [] } } } } });
    makeSession('issue', 4, { pid: alivePid() });
    thread(20, true, [{ id: 107, login: 'bob', body: '@sloth fix the typo' }]);
    await comments();
    expect(read(path.join(sessionDir('issue', 4), 'inbox', '107.md'))).toMatch(/^author: bob\nrole: developer\ncomment: 107\npr: 20\n/);
  });
  it('leaves a PR alone while its issue lookup is failing, and acts on the next tick', async () => {
    onGh(/api graphql .*pullRequest\(number: 22\)/, fail('HTTP 502'));
    thread(22, true, [{ id: 109, login: 'bob', body: '@sloth fix the flaky test' }]);
    await comments();
    // Neither answered as unwired nor marked seen: nothing is known about what the PR closes.
    expect(called(/issues\/22\/comments -f body=/)).toHaveLength(0);
    expect(spawned).toHaveLength(0);
    expect(exists(statePath('seen', '109'))).toBe(false);
    expect(readLog().join('\n')).toMatch(/PR #22: issue lookup failed \(HTTP 502\) — its comments wait for the next tick/);
    // GitHub answers on the next tick, and the order that was never lost starts its session.
    resetGh();
    onGh(/api graphql .*pullRequest\(number: 22\)/, { data: { repository: { pullRequest: { headRefName: 'sloth/issue-8-x', closingIssuesReferences: { nodes: [] } } } } });
    thread(22, true, [{ id: 109, login: 'bob', body: '@sloth fix the flaky test' }]);
    await comments();
    expect(spawned).toHaveLength(1);
    expect(exists(statePath('seen', '109'))).toBe(true);
  });
  it('tells the author when a PR is wired to no issue', async () => {
    onGh(/api graphql .*pullRequest\(number: 21\)/, { data: { repository: { pullRequest: { headRefName: 'feat', closingIssuesReferences: { nodes: [] } } } } });
    thread(21, true, [{ id: 108, login: 'bob', body: '@sloth review this' }]);
    await comments();
    expect(called(/api repos\/acme\/widgets\/issues\/21\/comments -f body=\*\*Sloth:\*\* This PR is not linked/)).toHaveLength(1);
    expect(spawned).toHaveLength(0);
  });

  describe('a comment on a line of the PR’s diff', () => {
    // The mention search reads conversations only: a `@sloth` written on a line of the diff never
    // shows up in it, so Sloth left the question unanswered and without so much as a 👀.
    it('reaches the live session’s inbox, saying which line it was written on, and gets its 👀 in the review thread', async () => {
      wired(20, 4);
      makeSession('issue', 4, { pid: alivePid() });
      reviewThread(20, [{ id: 300, login: 'carol', body: '@sloth why do we have both fields?', path: 'schema.prisma', line: 50 }]);
      await comments();
      expect(read(path.join(sessionDir('issue', 4), 'inbox', 'review-300.md'))).toBe(
        'author: carol\nrole: tester\ncomment: 300\npr: 20\nthread: review\npath: schema.prisma\nline: 50\n\n@sloth why do we have both fields?\n',
      );
      expect(called(/reactions/).map((c) => c.args[1])).toEqual(['repos/acme/widgets/pulls/comments/300/reactions']);
      expect(exists(statePath('seen', 'review-300'))).toBe(true);
    });
    it('answers a question there with a status reply that knows the thread', async () => {
      wired(20, 4);
      reviewThread(20, [{ id: 301, login: 'alice', body: '@sloth is this field still needed?' }]);
      await comments();
      expect(spawned.map((s) => s.args[1])).toEqual(['/sloth:status 4 301']);
      expect(spawned[0].options.env.SLOTH_PR).toBe('20');
      expect(spawned[0].options.env.SLOTH_REVIEW_COMMENT).toBe('301');
      expect(exists(statePath('status', '4-review-301'))).toBe(true);
    });
    it('starts a session on a developer’s order written there', async () => {
      wired(20, 4);
      reviewThread(20, [{ id: 302, login: 'bob', body: '@sloth drop the second field' }]);
      await comments();
      expect(spawned[0].args[1]).toBe('/sloth:implement 4 Order from bob (developer, PR #20 review comment 302): @sloth drop the second field');
    });
    it('relaunches a parked card on an answer written there — trigger 6 reads the conversation only', async () => {
      wired(20, 5);
      makeSession('issue', 5, { blocked: '1', retries: '2' });
      reviewThread(20, [{ id: 303, login: 'carol', body: '@sloth keep both, the history is audited' }]);
      await comments();
      expect(spawned[0].args[1]).toMatch(/^\/sloth:implement 5 Answer from carol \(tester\) in a review thread on PR #20 \(review comment 303\)/);
      expect(exists(sessionDir('issue', 5), 'retries')).toBe(false);
      expect(exists(statePath('seen', 'review-303'))).toBe(true);
    });
    it('reads both the conversation and the review threads of a PR that has a mention in each', async () => {
      wired(20, 4);
      makeSession('issue', 4, { pid: alivePid() });
      thread(20, true, [{ id: 110, login: 'bob', body: '@sloth in the conversation' }]);
      reviewThread(20, [{ id: 304, login: 'bob', body: '@sloth on a line' }]);
      await comments();
      expect(fs.readdirSync(path.join(sessionDir('issue', 4), 'inbox')).sort()).toEqual(['110.md', 'review-304.md']);
      expect(called(/api graphql/)).toHaveLength(1);
    });
    it('tells the author in the thread when the PR is wired to no issue, and ignores a stranger there', async () => {
      onGh(/api graphql .*pullRequest\(number: 21\)/, { data: { repository: { pullRequest: { headRefName: 'feat', closingIssuesReferences: { nodes: [] } } } } });
      reviewThread(21, [{ id: 305, login: 'bob', body: '@sloth review this' }, { id: 306, login: 'mallory', body: '@sloth do it' }]);
      await comments();
      expect(called(/api repos\/acme\/widgets\/pulls\/21\/comments\/305\/replies -f body=\*\*Sloth:\*\* This PR is not linked/)).toHaveLength(1);
      expect(called(/reactions/)).toHaveLength(1);
      expect(exists(statePath('seen', 'review-306'))).toBe(true);
    });
  });
});
