import fs from 'node:fs';
import path from 'node:path';
import { cfg } from '../config';
import { freeIn, moveCard, pickupOrder, wiredPrs } from './board';
import type { BoardItem, Verdict } from './board';
import { comment, gh } from './gh';
import { isDry, log, remove, write } from './log';
import { APPROVED_LABEL, MARKERS, OWN_BRANCH, skipped, statePath, unapprove } from './markers';
import { exitReport, exitsOf, forgetExits } from './exits';
import { previewLink } from './preview';
import { park } from './run-control';
import { approvedDir, counter, dirAlive, isBlocked, issueAlive, issueDir, triesOn } from './session-dirs';
import { launch, launchApproved } from './spawn';

/**
 * The triggers the board itself pulls: the review a Code Review card gets (4), the hand-over of a passed
 * card (5), the relaunch of a stranded one (2) and the pickup column (1). What becomes of a run once it
 * is going — parking, stopping, reaping — is `run-control.ts`, re-exported here so the names every caller
 * and every test already knows keep working.
 */
export { park, pausedUntil, reap, stop } from './run-control';

/**
 * Trigger 4 — the review, and Sloth's first priority: it runs ahead of every other trigger that starts a
 * session, and `launchApproved` is held by the machine alone, never by the session caps. Every Code Review
 * card with an open wired PR — draft or ready — gets `/sloth:review <pr> final` on `models.final`, once per
 * PR head: Sloth's own PR (its session's reviewer loop is not a second opinion) and a human's alike,
 * `Sloth: skip` or not, a GitHub approval or not, a draft or not — the column is the signal.
 * The verdict lands on the PR either way; a pass labels the issue `Fable: approved` and moves the card to
 * Approved, where a human tests it, and a fail sends it back to In Progress, where trigger 2 relaunches the
 * session on the findings (a rejected skipped card keeps its label, so the human keeps it). The marker of
 * the head keeps it from being reviewed twice. An Approved card whose *current* head has no marker was
 * pushed to after its pass, or put there by hand: the label no longer describes what is on the branch, so it
 * goes and the card comes back to Code Review to be reviewed like any other — unless a session is already on
 * the issue (trigger 7 sent it back to fix the checks), which moves the card itself. Checks decide the rest:
 * a pending rollup is worth waiting one tick for, a red one belongs to trigger 7.
 * At most `maxActive` reviews start in one tick: the machine is read once, before the tick, so the reading
 * `launchApproved` is held by goes stale the moment the first one starts — a Code Review backlog would
 * otherwise become a burst of detached runs no hold could see. The ones that wait are left unmarked, so
 * they keep their turn and go on the next tick, on a fresh reading.
 *
 * A review that dies before it posts a verdict has its head's marker cleared by `reap`, so this trigger
 * gives the head the review it never got. That is right once and wrong for ever: a head whose review dies
 * every time — a model that runs out, a PR too large to read — was reviewed again on every tick, each one
 * a fresh session on `models.final`. `maxRetries + 1` of them is enough to call it: the marker is written
 * so the head is left alone, and the card goes to a human like every other run Sloth gives up on.
 *
 * One actor owns a card at a time. A Code Review card whose implement session is still running was
 * handed over a moment ago — the session is in its last steps — and the review waits for it to end: a
 * review that started meanwhile once rejected the PR and moved the card to In Progress while the session
 * was closing, and the session, which had never seen the verdict, wrote Code Review back over it — a
 * rejected head marked as reviewed, in a column that never launches anything, for good. The wait costs a
 * tick. And the verdict decides where a card lives, not the marker: a Code Review card whose current head
 * already has a verdict on the PR and nobody working on it is put where that verdict says (`heal`), which
 * unsticks a card left behind by any such race, including ones from before this one was closed.
 *
 * With `resolveConflicts` on, an unreviewed Code Review head of Sloth's own that conflicts with its base is
 * trigger 10's first: the round-trip rewrites the head, and a review of the old one would be a second review paid
 * for nothing — and a verdict on a head nobody can merge. The head is left unmarked, so it keeps its turn
 * and is reviewed as soon as it merges. A human's PR and a skipped card are not resolved, so they are
 * reviewed as they are — and so is a head whose round-trip already ran and left it conflicting
 * (`state/conflicts/<pr>-<sha>` with no session on the issue): trigger 10 will not try that head again,
 * and a card nobody reviews and nobody works on would sit in Code Review for good.
 */
export async function reviews(board: BoardItem[]): Promise<void> {
  const col = cfg().statusField.columns;
  const inApproved = (i: BoardItem) => !!col.approved.id && i.status === col.approved.name;
  const cards = board.filter((i) => i.status === col.codeReview.name || inApproved(i));
  const perTick = Math.max(1, cfg().maxActive);
  let started = 0;
  for (const { issue, pr, sha, head, checks, mergeable, verdict } of await wiredPrs(cards.map((i) => i.number))) {
    const marker = statePath(MARKERS.approved, `${pr}-${sha}`);
    const card = cards.find((i) => i.number === issue);
    if (dirAlive(approvedDir(pr))) continue;
    if (fs.existsSync(marker)) {
      if (card && !inApproved(card) && verdict && !issueAlive(issue)) await heal(card, pr, sha, verdict);
      continue;
    }
    if (cfg().resolveConflicts && mergeable === 'CONFLICTING' && OWN_BRANCH.test(head) && card && !inApproved(card) && !skipped(card) && !fs.existsSync(statePath('conflicts', `${pr}-${sha}`))) {
      log(`review PR #${pr} waits: head ${sha.slice(0, 7)} conflicts with its base, and the conflicts are resolved first`);
      continue;
    }
    if (issueAlive(issue)) {
      if (card && !inApproved(card)) log(`review PR #${pr} waits: the session on #${issue} is still running`);
      continue;
    }
    if (card && inApproved(card)) {
      if (card.labels.includes(APPROVED_LABEL)) await unapprove(issue, `PR #${pr} was pushed to after its review passed`);
      log(`#${issue} back to ${col.codeReview.name}: PR #${pr} head ${sha.slice(0, 7)} has not been reviewed`);
      if (!(await moveCard(issue, col.codeReview.id))) continue;
    }
    if (checks === 'PENDING') {
      log(`review PR #${pr} waits for its checks`);
      continue;
    }
    if (checks === 'FAILURE') continue;
    const tries = triesOn(approvedDir(pr), sha);
    if (tries > cfg().maxRetries) {
      if (!isDry()) write(marker, '');
      log(`review PR #${pr} given up: it ended without a verdict ${tries} times on ${sha.slice(0, 7)}`);
      await park(issue, `the review of PR #${pr} ended without a verdict ${tries} times on ${sha.slice(0, 7)}.`);
      continue;
    }
    // The give-up above is about this head for good; this one only about this tick.
    if (started >= perTick) {
      log(`review PR #${pr} waits for the next tick (${perTick} reviews started in this one)`);
      continue;
    }
    if (!launchApproved(pr, issue, sha)) continue;
    started += 1;
    if (!isDry()) write(marker, '');
  }
}

/**
 * A Code Review card whose head has its verdict on the PR and no one on it: the card sits where the
 * verdict did not put it. A fail goes back to In Progress, where trigger 2 relaunches the session on the
 * findings; a pass goes on to Approved with the label, as the review would have — the only way a card
 * gets there is a passing review, and this is that review, delivered late. Without an Approved column a
 * passed card stays where it is, as it does after the review itself.
 */
async function heal(card: BoardItem, pr: number, sha: string, verdict: Verdict): Promise<void> {
  const c = cfg();
  const col = c.statusField.columns;
  const issue = card.number;
  const to = verdict === 'failed' ? col.inProgress : col.approved;
  if (!to.id) return;
  log(`#${issue} to ${to.name}: the review of PR #${pr} head ${sha.slice(0, 7)} ${verdict}, and the card was left in ${card.status}`);
  if (!(await moveCard(issue, to.id))) return;
  if (isDry() || verdict !== 'passed' || card.labels.includes(APPROVED_LABEL)) return;
  const r = await gh(['issue', 'edit', String(issue), '--repo', c.repo, '--add-label', APPROVED_LABEL]);
  if (!r.ok) log(`#${issue} label "${APPROVED_LABEL}" not added: ${r.err.split('\n')[0]}`);
}

/**
 * Trigger 5 — the hand-over to a human. An Approved card whose PR passed the review on its current head gets
 * one comment on the issue: the card is ready for testing, with the preview link when the app the session
 * left running is up behind one (how to sign in is on the PR, under the same link), or the PR to check out
 * when there is none — a human's PR, previews off, an app that could not be left up. Once per PR head
 * (`state/handed/<pr>-<sha>`), so a head that comes back after a push and passes again is announced again.
 * A `Sloth: skip` card is left alone — a human owns it and does not need telling. No Approved column
 * configured → nothing to do.
 */
export async function handover(board: BoardItem[]): Promise<void> {
  const c = cfg();
  const column = c.statusField.columns.approved;
  if (!column.id) return;
  const issues = board.filter((i) => i.status === column.name && i.labels.includes(APPROVED_LABEL) && !skipped(i)).map((i) => i.number);
  for (const { issue, pr, sha } of await wiredPrs(issues)) {
    const marker = statePath('handed', `${pr}-${sha}`);
    if (fs.existsSync(marker) || !fs.existsSync(statePath(MARKERS.approved, `${pr}-${sha}`)) || dirAlive(approvedDir(pr))) continue;
    const link = previewLink(issue);
    const where = link
      ? `Test it here: ${link} — how to sign in is on the PR, under the same link.`
      : `No preview for this one — check the PR out to test it: https://github.com/${c.repo}/pull/${pr}`;
    const body = `${c.botPrefix} PR #${pr} passed the review — the card is in **${column.name}**, ready for a human to test.\n${where}`;
    if (isDry()) {
      log(`dry-run: would tell #${issue} it is ready to test${link ? ` at ${link}` : ''}`);
      continue;
    }
    // The marker means "this head has been announced", so it is written only once the announcement is on
    // the issue. A `gh` GitHub refused used to mark the head all the same: nobody was ever told the card
    // was ready, and nothing would tell them, because the head had had its turn. `comment` logs the reason;
    // the next tick tries again.
    if (!(await comment(c.repo, issue, body))) continue;
    log(`#${issue} ready to test${link ? ` at ${link}` : ' (no preview)'} — PR #${pr}`);
    write(marker, '');
  }
}

/** Trigger 2 — In Progress cards with no live session: a reboot or a usage-limit retry, capped. */
export async function retryStranded(board: BoardItem[]): Promise<void> {
  for (const issue of freeIn(board, cfg().statusField.columns.inProgress.name)) {
    if (issueAlive(issue) || isBlocked(issueDir(issue))) continue;
    const dir = issueDir(issue);
    const retries = counter(dir, 'retries');
    if (retries >= cfg().maxRetries) {
      const runs = exitsOf(dir).length || retries;
      await park(issue, `the run for this issue stopped without finishing ${runs} times in a row.`, exitReport(dir));
      continue;
    }
    if (!(await launch(issue))) break;
    if (!isDry()) write(path.join(issueDir(issue), 'retries'), String(retries + 1));
  }
}

/** Trigger 1 — the watched column, in the board's priority order. A fresh pickup resets the retry counter. */
export async function pickup(board: BoardItem[]): Promise<void> {
  for (const issue of pickupOrder(board, cfg().statusField.columns.pickup.name)) {
    if (issueAlive(issue)) continue;
    if (!(await launch(issue))) break;
    if (!isDry()) {
      remove(path.join(issueDir(issue), 'retries'));
      forgetExits(issueDir(issue));
      // A pickup is a start-over, so the dead run's handoff note goes too — only a retry continues from it.
      // The ledger hears the same: this run took nothing up, so no failed run before it is charged for.
      remove(path.join(issueDir(issue), 'handoff.md'));
      write(path.join(issueDir(issue), 'started_fresh'), '1');
    }
  }
}
