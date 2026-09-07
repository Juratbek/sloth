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
  it('does not start a second session while the review of the card’s PR is still running, and says so', async () => {
    // Trigger 4 waits for an implement session so one actor owns a card at a time; nothing waited the other
    // way round. `@sloth address the review comments`, written while the review read the diff, cleaned the
    // run environment, moved the card to In Progress and pushed to the branch the reviewer was about to
    // post a verdict on — and move the card by. The order is answered rather than held for a later tick:
    // the comment search reads the last hour only, and a review may run to its whole budget.
    makeSession('approved', 9, { pid: alivePid(), issue: '4' });
    thread(4, false, [{ id: 104, login: 'bob', body: '@sloth address the review comments' }]);
    await comments();
    expect(spawned).toHaveLength(0);
    expect(called(/api repos\/acme\/widgets\/issues\/4\/comments -f body=.*review of this card is still running/)).toHaveLength(1);
    expect(exists(statePath('seen', '104'))).toBe(true);
    expect(readLog().join('\n')).toMatch(/comment 104 not acted on — the review of the card is still running/);
  });

  it('asks GitHub for the label when there is no board yet, rather than reading every card as unlabelled', async () => {
    // `snapshot()` is empty for the seconds after a restart — the comment timer fires at 20s, the board's
    // at 5s — and a slow or a failed board read leaves it empty for longer. A card missing from an empty
    // board reads exactly like a card with no label, and unlike `awaitingAnswer` there is no marker on
    // disk to fall back on: the one card in hand is asked about directly instead.
    onGh(/issue view 4 --repo acme\/widgets --json labels/, 'Sloth: skip\nbug');
    thread(4, false, [{ id: 130, login: 'bob', body: '@sloth start over with the other approach' }]);
    await comments();
    expect(spawned).toHaveLength(0);
    expect(called(/issues\/4\/comments -f body=.*Sloth: skip.*a person owns it/)).toHaveLength(1);
  });

  it('says nothing and marks nothing seen when the labels cannot be read — that is not an answer', async () => {
    // Not knowing is not knowing there is no label, and it is not the skip label either: answering with
    // the skip refusal tells the developer to take off a label that may not be there, and marking it seen
    // makes that the last word. The order is left for a tick that can read the card, the way a PR whose
    // wiring is unknown is left — `LOOKBACK` is an hour, so it has many ticks to land in.
    onGh(/issue view 4 --repo acme\/widgets --json labels/, fail('HTTP 503'));
    thread(4, false, [{ id: 131, login: 'bob', body: '@sloth start over with the other approach' }]);
    await comments();
    expect(spawned).toHaveLength(0);
    expect(called(/issues\/4\/comments -f body=/)).toHaveLength(0);
    expect(exists(statePath('seen', '131'))).toBe(false);
    expect(readLog().join('\n')).toMatch(/the labels could not be read/);
  });

  it('asks GitHub for a card the board it read does not carry, so an off-board card is not read as unlabelled', async () => {
    setSnapshot([card(3, COLUMNS.inProgress.name)]);
    onGh(/issue view 4 --repo acme\/widgets --json labels/, 'Sloth: skip');
    thread(4, false, [{ id: 132, login: 'bob', body: '@sloth start over with the other approach' }]);
    await comments();
    expect(spawned).toHaveLength(0);
    expect(called(/issues\/4\/comments -f body=.*Sloth: skip.*a person owns it/)).toHaveLength(1);
  });

  it('leaves an unwired PR comment unseen when the reply GitHub refused never landed', async () => {
    // Marked seen on a refusal, the commenter keeps the 👀 and is never told anything at all — there is
    // nothing left on a later tick to say it on.
    onGh(/api graphql .*pullRequest\(number: 9\)/, { data: { repository: { pullRequest: { headRefName: 'topic/x', closingIssuesReferences: { nodes: [] } } } } });
    onGh(/api -X GET search\/issues/, ({ line }) => (line.includes('"@sloth"') ? '9 true' : undefined));
    onGh(/api repos\/acme\/widgets\/issues\/9\/comments\?since/, [{ id: 140, login: 'bob', body: '@sloth do it' }].map(b64).join('\n'));
    onGh(/api repos\/acme\/widgets\/issues\/9\/comments -f body=/, fail('HTTP 502'));
    await comments();
    expect(exists(statePath('seen', '140'))).toBe(false);
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

  it('leaves an answer in a review thread alone on a card a human has taken over', async () => {
    // The review-thread answer is the other caller of `launch` here, and `launch` has no skip check of its
    // own. Trigger 6 filters skipped cards with `freeIn`, so only this door was open: a tester's `@sloth`
    // on a line of the diff started a session on a card a person was working by hand.
    makeSession('issue', 4, { blocked: '1' });
    setSnapshot([card(4, COLUMNS.needsHelp.name, { labels: ['Sloth: skip'] })]);
    reviewThread(7, [{ id: 106, login: 'carol', body: '@sloth this is still broken' }]);
    wired(7, 4);
    await comments();
    expect(spawned).toHaveLength(0);
    expect(called(/api repos\/acme\/widgets\/pulls\/7\/comments\/106\/replies -f body=.*Sloth: skip/)).toHaveLength(1);
    expect(exists(statePath('seen', 'review-106'))).toBe(true);
  });

  it('says nothing in the conversation of a parked card whose own run will come back to it', async () => {
    // `answerOn` reads Sloth's *last* comment on the issue as the question being asked. A `**Sloth:**`
    // refusal written under the developer's answer would make that answer stop counting, and the card
    // would sit parked until somebody wrote a third comment — the same trap `awaitingAnswer` documents
    // for a status reply. Nothing is lost by saying nothing: the card is Sloth's, and trigger 6 relaunches
    // it from the same thread as soon as the review is over.
    makeSession('issue', 4, { blocked: '1' });
    makeSession('approved', 9, { pid: alivePid(), issue: '4' });
    setSnapshot([card(4, COLUMNS.needsHelp.name)]);
    thread(4, false, [{ id: 108, login: 'bob', body: '@sloth start over' }]);
    await comments();
    expect(spawned).toHaveLength(0);
    expect(called(/issues\/4\/comments -f body=/)).toHaveLength(0);
    expect(exists(statePath('seen', '108'))).toBe(true);
    expect(readLog().join('\n')).toMatch(/comment 108 not acted on — the review of the card is still running/);
  });

  it('still answers in a review thread on such a card — that reply is not in the conversation', async () => {
    // The swallow is bought by `answerOn` reading Sloth's last *conversation* comment as the question. A
    // reply on a line of the diff is not in the conversation and cancels nothing, so there is no reason to
    // pay for it with a silence: the developer is told why nothing started.
    makeSession('issue', 4, { blocked: '1' });
    makeSession('approved', 9, { pid: alivePid(), issue: '4' });
    setSnapshot([card(4, COLUMNS.needsHelp.name)]);
    reviewThread(7, [{ id: 110, login: 'bob', body: '@sloth start over' }]);
    wired(7, 4);
    await comments();
    expect(spawned).toHaveLength(0);
    expect(called(/pulls\/7\/comments\/110\/replies -f body=.*review of this card is still running/)).toHaveLength(1);
    expect(exists(statePath('seen', 'review-110'))).toBe(true);
  });

  it('still answers on a parked card a human has taken over, which nothing else will come back to', async () => {
    // `freeIn` keeps trigger 6 off a skipped card entirely, so there is no pending answer to cancel and no
    // second chance to say it later: swallowed here, the developer is told nothing at all, ever.
    makeSession('issue', 4, { blocked: '1' });
    setSnapshot([card(4, COLUMNS.needsHelp.name, { labels: ['Sloth: skip'] })]);
    thread(4, false, [{ id: 109, login: 'bob', body: '@sloth start over' }]);
    await comments();
    expect(spawned).toHaveLength(0);
    expect(called(/issues\/4\/comments -f body=.*Sloth: skip.*a person owns it/)).toHaveLength(1);
    expect(exists(statePath('seen', '109'))).toBe(true);
  });

  it('leaves a held order unseen when the reply GitHub was given did not land', async () => {
    // The marker means "this comment has been answered". Written whatever GitHub said, a reply lost to a
    // blip left the developer with 👀 and silence, and the search window closes an hour later.
    setSnapshot([card(4, COLUMNS.inProgress.name, { labels: ['Sloth: skip'] })]);
    // Registered ahead of the thread, whose pattern would otherwise answer the reply's POST as well.
    onGh(/issues\/4\/comments -f body=/, fail('the API is having a moment'));
    thread(4, false, [{ id: 107, login: 'bob', body: '@sloth start over' }]);
    await comments();
    expect(spawned).toHaveLength(0);
    expect(exists(statePath('seen', '107'))).toBe(false);
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
