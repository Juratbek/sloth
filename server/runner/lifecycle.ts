import fs from 'node:fs';
import { cfg } from '../config';
import { label } from '../repos';
import { refKey, type IssueRef, type PrRef } from '../repo-types';
import { moveCard, wiredPrs } from './board';
import type { BoardItem, WiredPr } from './board';
import { cleanup } from './cleanup';
import { gh } from './gh';
import { isDry, log, remove, write } from './log';
import { APPROVED_LABEL, OWN_BRANCH, headMarker, marker, skipped, statePath, unapprove } from './markers';
import { workedColumns } from './columns';
import { stopPreview } from './preview';
import { approvedDir, dirAlive, issueAlive } from './session-dirs';
import { launch } from './spawn';
import { park } from './run-control';

/**
 * The end of a card's life: what Sloth does once the work is over or the PR turns out not to be done
 * after all. Triggers 6, 7, 8 and 10 — a closed issue is filed away and its leftovers swept up, a red check
 * on Sloth's own PR goes back to the session that wrote it, a PR that passed its review is merged when the
 * user asked for that, and a Code Review PR that no longer merges is sent back to be made mergeable when
 * the user asked for that too.
 */

const handedOverColumns = (): string[] => {
  const col = cfg().statusField.columns;
  return [col.codeReview, col.approved].map((c) => c.name).filter(Boolean);
};

const listMarkers = (dir: string): string[] => {
  try {
    return fs.readdirSync(statePath(dir));
  } catch {
    return [];
  }
};

/** Drops the remote branch of a PR Sloth wrote; a 422 means someone (GitHub's own auto-delete) got there first. */
async function deleteBranch(issue: IssueRef, pr: PrRef, branch: string): Promise<void> {
  if (isDry()) {
    log(`dry-run: would delete branch ${branch}`);
    return;
  }
  const r = await gh(['api', '-X', 'DELETE', `repos/${pr.repo}/git/refs/heads/${branch}`]);
  const first = r.err.split('\n')[0];
  if (r.ok) log(`${label(issue)} branch ${branch} deleted`);
  else if (/\b(404|422)\b|Reference does not exist|Not Found/i.test(first)) log(`${label(issue)} branch ${branch} was already gone`);
  else log(`${label(issue)} branch ${branch} delete failed: ${first}`);
}

/** One closed issue: its card to Done, its run swept up, the branches it was written on dropped. */
async function file(item: BoardItem, prs: WiredPr[]): Promise<void> {
  const done = cfg().statusField.columns.done;
  log(`${label(item)} is closed — filing it away from ${item.status}`);
  // A failed move is retried next tick rather than remembered: the card would sit in the wrong column forever.
  const moved = done.id ? await moveCard(item, done.id) : true;
  // A live session is still writing; it tears its own environment down, and the next tick sees the card again.
  if (!issueAlive(item)) {
    if (isDry()) log(`dry-run: would take ${label(item)}'s preview, servers and worktree down`);
    else {
      await stopPreview(item, 'the issue is closed');
      await cleanup(item);
    }
  }
  for (const { pr, head } of prs) if (OWN_BRANCH.test(head)) await deleteBranch(item, pr, head);
  if (moved && !isDry()) write(marker('finished', String(item.number), item), '');
}

/**
 * A card handed over whose PR was closed unmerged: the branch is not going anywhere on its own, so the
 * issue goes back to a human with one comment, once per PR.
 */
async function abandoned(cards: BoardItem[]): Promise<void> {
  const open = new Set<string>();
  const closed = new Map<string, { issue: IssueRef; pr: PrRef }>();
  for (const p of await wiredPrs(cards, { states: ['OPEN', 'CLOSED'] })) {
    if (p.state === 'OPEN') open.add(refKey(p.issue));
    else if (!closed.has(refKey(p.issue))) closed.set(refKey(p.issue), { issue: p.issue, pr: p.pr });
  }
  for (const { issue, pr } of closed.values()) {
    const closedMarker = marker('closed', String(pr.number), pr);
    if (open.has(refKey(issue)) || issueAlive(issue) || fs.existsSync(closedMarker)) continue;
    await park(issue, `its PR #${pr.number} was closed without being merged.`);
    if (!isDry()) write(closedMarker, '');
  }
}

/**
 * Trigger 6 — the issue is closed, so Sloth is done with the card whatever column it sits in and whoever
 * it is assigned to: the close is the signal, not the board. The card goes to Done (when a Done column is
 * configured), the run's servers, database and worktree go, and the branch of the PR that closed it is
 * deleted — it is Sloth's own, nobody is going to push to it again. `state/finished/<issue>` remembers the
 * pass so a board without a Done column is not swept every five minutes; re-opening the issue drops it,
 * and the next close files the card away again. The other half of the trigger is the opposite ending: a PR
 * closed *without* being merged leaves the issue open with nothing in flight, which is a human's call.
 */
export async function finished(board: BoardItem[]): Promise<void> {
  const worked = workedColumns();
  const open = new Set(board.filter((i) => !i.closed).map((i) => marker('finished', String(i.number), i)));
  for (const f of listMarkers('finished')) if (open.has(statePath('finished', f))) remove(statePath('finished', f));

  const cards = board.filter((i) => worked.includes(i.status));
  const closed = cards.filter((i) => i.closed && !fs.existsSync(marker('finished', String(i.number), i)));
  if (closed.length) {
    // Merged only: the branch of a PR that was closed unmerged may still be someone's work in progress.
    const merged = await wiredPrs(closed, { states: ['MERGED'] });
    for (const item of closed) await file(item, merged.filter((p) => refKey(p.issue) === refKey(item)));
  }

  const handed = handedOverColumns();
  const stranded = cards.filter((i) => !i.closed && !skipped(i) && handed.includes(i.status));
  if (stranded.length) await abandoned(stranded);
}

/**
 * Trigger 7 — the checks on a PR Sloth wrote are red. The implement session had them green (or had none)
 * when it handed the PR over, so a failure here is a round-trip like a review finding: the same session
 * command goes back to the branch, fixes it and pushes, and the PR keeps its number and its comments.
 * Once per `<pr>-<sha>`, so a fix that fails again is not re-launched until the head moves. A human's PR
 * is left alone — its author owns its checks. `launch` moves the card to In Progress itself; a card that
 * had already passed its review loses that label first, since what is on the branch no longer has it.
 */
export async function failedChecks(board: BoardItem[]): Promise<void> {
  const columns = handedOverColumns();
  const cards = board.filter((i) => columns.includes(i.status) && !skipped(i));
  if (!cards.length) return;
  for (const { issue, pr, sha, head, checks } of await wiredPrs(cards)) {
    if (!OWN_BRANCH.test(head) || checks !== 'FAILURE') continue;
    const checked = marker('checks', `${pr.number}-${sha}`, pr);
    // A review still reading this PR owns the card, as it does in every other wired-PR trigger: a session
    // started here would push a new head while the reviewer posts its verdict on the old one and moves the
    // card by it — a rejected head marked as reviewed, in a column that launches nothing.
    if (fs.existsSync(checked) || issueAlive(issue) || dirAlive(approvedDir(pr))) continue;
    if (cards.find((i) => refKey(i) === refKey(issue))?.labels.includes(APPROVED_LABEL)) {
      await unapprove(issue, `the checks on PR #${pr.number} fail`);
    }
    const order =
      `The checks on PR #${pr.number}${pr.repo !== issue.repo ? ` in ${pr.repo}` : ''} fail on commit ${sha.slice(0, 7)}: this is a review round-trip — ` +
      'check the branch out, make the checks pass, push, keep the PR.';
    if (!(await launch(issue, order))) break;
    if (!isDry()) write(checked, '');
  }
}

/**
 * Trigger 10 — a PR Sloth wrote conflicts with its base, its card in Code Review. Every PR Sloth opens
 * moves the base for every other one still open, so with a few of them in flight the older ones stop
 * merging; a human resolving them by hand is the work this trigger takes over, when `resolveConflicts`
 * says so. The same round-trip as trigger 7: the implement session goes back to the branch, merges the
 * base in, resolves the conflicts, gets the checks green and pushes — the PR keeps its number — and the
 * card comes back to Code Review on a new head, which trigger 4 then reviews. Once per `<pr>-<sha>`, so a
 * head the session could not resolve is not tried again until the branch moves. Code Review only: an
 * Approved card's conflict is a human's to see before the merge (trigger 8 says so, once), and a card
 * still In Progress has its session on it. A human's PR, a `Sloth: skip` card, a live session on the
 * issue and a review still running on the PR are all left alone — one actor owns a card at a time, and
 * the review's own verdict would otherwise land on a head this run is rewriting. `UNKNOWN` is GitHub
 * still computing: worth waiting a tick for.
 */
export async function conflicts(board: BoardItem[]): Promise<void> {
  const c = cfg();
  if (!c.resolveConflicts) return;
  const column = c.statusField.columns.codeReview.name;
  const cards = board.filter((i) => i.status === column && !skipped(i));
  if (!cards.length) return;
  for (const { issue, pr, sha, head, base, mergeable } of await wiredPrs(cards)) {
    if (!OWN_BRANCH.test(head) || mergeable !== 'CONFLICTING') continue;
    const conflicted = marker('conflicts', `${pr.number}-${sha}`, pr);
    if (fs.existsSync(conflicted) || issueAlive(issue) || dirAlive(approvedDir(pr))) continue;
    const into = base ? `\`origin/${base}\`` : 'its base branch';
    const order =
      `PR #${pr.number}${pr.repo !== issue.repo ? ` in ${pr.repo}` : ''} conflicts with its base on commit ${sha.slice(0, 7)}: this is a review round-trip — ` +
      `check the branch out, merge ${into} into it, resolve every conflict keeping what both sides meant, ` +
      'make the checks pass, push, keep the PR. Merge only: never rebase, never force-push.';
    if (!(await launch(issue, order))) break;
    if (!isDry()) write(conflicted, '');
  }
}

// Why a PR was not merged is worth saying once, not every five minutes until the human fixes it.
const told = new Set<string>();
function say(key: string, message: string): void {
  if (told.has(key)) return;
  told.add(key);
  log(message);
}

async function merge(pr: PrRef, sha: string): Promise<void> {
  const c = cfg();
  if (isDry()) {
    log(`dry-run: would merge PR #${pr.number} (--${c.autoMerge})`);
    return;
  }
  const r = await gh(['pr', 'merge', String(pr.number), '--repo', pr.repo, `--${c.autoMerge}`]);
  if (r.ok) {
    write(marker('merged', `${pr.number}-${sha}`, pr), '');
    log(`PR #${pr.number} merged (${c.autoMerge})`);
    return;
  }
  // Not retried on this head: a merge that GitHub refused once refuses again until something changes.
  write(marker('merge-failed', `${pr.number}-${sha}`, pr), '');
  log(`PR #${pr.number} merge failed: ${r.err.split('\n')[0]}`);
}

/**
 * Trigger 8 — a PR that passed its review is merged, with the `gh pr merge` method in `autoMerge`. Off
 * unless the user set one: it merges as soon as the review passed, so it skips the human test in Approved,
 * which is the last thing a human might want to keep. Everything has to line up on the *current* head — the
 * pass (`state/approved/<pr>-<sha>` plus the label), no review still running, green or absent checks, a
 * clean merge and a PR that is no draft — so a push after the pass, a red check or a conflict all hold the
 * merge until the card has been through trigger 4 (or 7) again, and a draft holds it until someone marks
 * it ready. A card whose work spans two repositories merges both PRs or neither: one held holds the other.
 * A `Sloth: skip` card is left alone like everywhere but trigger 4: its review still runs, but merging the
 * PR of a card a human has taken over is not Sloth's to do.
 */
export async function autoMerge(board: BoardItem[]): Promise<void> {
  const c = cfg();
  const column = c.statusField.columns.approved;
  if (!c.autoMerge || !column.id) return;
  // Skipped cards included would be the one place Sloth acts on a card a human took over: trigger 4
  // reviews them on purpose — the column is the signal there — and a pass labels and moves them here.
  const issues = board.filter((i) => i.status === column.name && i.labels.includes(APPROVED_LABEL) && !skipped(i));
  const prs = await wiredPrs(issues);
  const ready = (p: WiredPr) => {
    const head = `${p.pr.number}-${p.sha}`;
    if (!fs.existsSync(headMarker('approved', p.pr, p.sha)) || dirAlive(approvedDir(p.pr))) return false;
    if (fs.existsSync(marker('merged', head, p.pr)) || fs.existsSync(marker('merge-failed', head, p.pr))) return false;
    if (p.draft) say(head, `PR #${p.pr.number} is not merged: it is still a draft`);
    else if (p.checks === 'FAILURE') say(head, `PR #${p.pr.number} is not merged: its checks fail`);
    else if (p.mergeable === 'CONFLICTING') say(head, `PR #${p.pr.number} is not merged: it conflicts with its base`);
    else return p.checks !== 'PENDING' && p.mergeable === 'MERGEABLE';
    return false;
  };
  const okay = new Set(prs.filter(ready).map((p) => refKey(p.pr)));
  for (const p of prs) {
    if (!okay.has(refKey(p.pr))) continue;
    const siblings = prs.filter((s) => refKey(s.issue) === refKey(p.issue) && s.state === 'OPEN');
    if (siblings.some((s) => !okay.has(refKey(s.pr)) && !fs.existsSync(marker('merged', `${s.pr.number}-${s.sha}`, s.pr)))) {
      say(`${p.pr.number}-${p.sha}-wait`, `PR #${p.pr.number} is not merged yet: the card's other PR is not ready`);
      continue;
    }
    await merge(p.pr, p.sha);
  }
}
