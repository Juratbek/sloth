import fs from 'node:fs';
import { cfg } from '../config';
import { moveCard, wiredPrs } from './board';
import type { BoardItem } from './board';
import { cleanup } from './cleanup';
import { gh } from './gh';
import { isDry, log, remove, write } from './log';
import { APPROVED_LABEL, MARKERS, OWN_BRANCH, statePath, unapprove } from './markers';
import { stopPreview } from './preview';
import { approvedDir, dirAlive, issueAlive } from './session-dirs';
import { launch } from './spawn';
import { park } from './triggers';

/**
 * The end of a card's life: what Sloth does once the work is over or the PR turns out not to be done
 * after all. Triggers 6, 7 and 8 — a closed issue is filed away and its leftovers swept up, a red check
 * on Sloth's own PR goes back to the session that wrote it, and a PR that passed its final review is
 * merged when the user asked for that.
 */

/** The columns Sloth still has something to do in — a card outside them is nobody's business here. */
const workedColumns = (): string[] => {
  const col = cfg().statusField.columns;
  return [col.inProgress, col.needsHelp, col.codeReview, col.approved].map((c) => c.name).filter(Boolean);
};

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
async function deleteBranch(issue: number, branch: string): Promise<void> {
  if (isDry()) {
    log(`dry-run: would delete branch ${branch}`);
    return;
  }
  const r = await gh(['api', '-X', 'DELETE', `repos/${cfg().repo}/git/refs/heads/${branch}`]);
  const first = r.err.split('\n')[0];
  if (r.ok) log(`#${issue} branch ${branch} deleted`);
  else if (/\b(404|422)\b|Reference does not exist|Not Found/i.test(first)) log(`#${issue} branch ${branch} was already gone`);
  else log(`#${issue} branch ${branch} delete failed: ${first}`);
}

/** One closed issue: its card to Done, its run swept up, the branch it was written on dropped. */
async function file(item: BoardItem, prs: { pr: number; head: string }[]): Promise<void> {
  const issue = item.number;
  const done = cfg().statusField.columns.done;
  log(`#${issue} is closed — filing it away from ${item.status}`);
  // A failed move is retried next tick rather than remembered: the card would sit in the wrong column forever.
  const moved = done.id ? await moveCard(issue, done.id) : true;
  // A live session is still writing; it tears its own environment down, and the next tick sees the card again.
  if (!issueAlive(issue)) {
    if (isDry()) log(`dry-run: would take #${issue}'s preview, servers and worktree down`);
    else {
      await stopPreview(issue, 'the issue is closed');
      await cleanup(issue);
    }
  }
  for (const { head } of prs) if (OWN_BRANCH.test(head)) await deleteBranch(issue, head);
  if (moved && !isDry()) write(statePath('finished', String(issue)), '');
}

/**
 * A card handed over whose PR was closed unmerged: the branch is not going anywhere on its own, so the
 * issue goes back to a human with one comment, once per PR.
 */
async function abandoned(cards: BoardItem[]): Promise<void> {
  const open = new Set<number>();
  const closed = new Map<number, number>();
  for (const p of await wiredPrs(cards.map((i) => i.number), { unapprovedOnly: false, states: ['OPEN', 'CLOSED'] })) {
    if (p.state === 'OPEN') open.add(p.issue);
    else if (!closed.has(p.issue)) closed.set(p.issue, p.pr);
  }
  for (const [issue, pr] of closed) {
    const marker = statePath('closed', String(pr));
    if (open.has(issue) || issueAlive(issue) || fs.existsSync(marker)) continue;
    await park(issue, `its PR #${pr} was closed without being merged.`);
    if (!isDry()) write(marker, '');
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
  const open = new Set(board.filter((i) => !i.closed).map((i) => String(i.number)));
  for (const f of listMarkers('finished')) if (open.has(f)) remove(statePath('finished', f));

  const cards = board.filter((i) => worked.includes(i.status));
  const closed = cards.filter((i) => i.closed && !fs.existsSync(statePath('finished', String(i.number))));
  if (closed.length) {
    // Merged only: the branch of a PR that was closed unmerged may still be someone's work in progress.
    const merged = await wiredPrs(closed.map((i) => i.number), { unapprovedOnly: false, states: ['MERGED'] });
    for (const item of closed) await file(item, merged.filter((p) => p.issue === item.number));
  }

  const handed = handedOverColumns();
  const stranded = cards.filter((i) => !i.closed && !i.assignees.length && handed.includes(i.status));
  if (stranded.length) await abandoned(stranded);
}

/**
 * Trigger 7 — the checks on a PR Sloth wrote are red. The implement session had them green (or had none)
 * when it handed the PR over, so a failure here is a round-trip like a review finding: the same session
 * command goes back to the branch, fixes it and pushes, and the PR keeps its number and its comments.
 * Once per `<pr>-<sha>`, so a fix that fails again is not re-launched until the head moves. A human's PR
 * is left alone — its author owns its checks. `launch` moves the card to In Progress itself; a card that
 * had already passed its final review loses that label first, since what is on the branch no longer has it.
 */
export async function failedChecks(board: BoardItem[]): Promise<void> {
  const columns = handedOverColumns();
  const cards = board.filter((i) => columns.includes(i.status) && !i.assignees.length);
  if (!cards.length) return;
  for (const { issue, pr, sha, head, checks } of await wiredPrs(cards.map((i) => i.number), { unapprovedOnly: false })) {
    if (!OWN_BRANCH.test(head) || checks !== 'FAILURE') continue;
    const marker = statePath('checks', `${pr}-${sha}`);
    if (fs.existsSync(marker) || issueAlive(issue)) continue;
    if (cards.find((i) => i.number === issue)?.labels.includes(APPROVED_LABEL)) {
      await unapprove(issue, `the checks on PR #${pr} fail`);
    }
    const order =
      `The checks on PR #${pr} fail on commit ${sha.slice(0, 7)}: this is a review round-trip — ` +
      'check the branch out, make the checks pass, push, keep the PR.';
    if (!(await launch(issue, order))) break;
    if (!isDry()) write(marker, '');
  }
}

// Why a PR was not merged is worth saying once, not every five minutes until the human fixes it.
const told = new Set<string>();
function say(key: string, message: string): void {
  if (told.has(key)) return;
  told.add(key);
  log(message);
}

async function merge(pr: number, sha: string): Promise<void> {
  const c = cfg();
  if (isDry()) {
    log(`dry-run: would merge PR #${pr} (--${c.autoMerge})`);
    return;
  }
  const r = await gh(['pr', 'merge', String(pr), '--repo', c.repo, `--${c.autoMerge}`]);
  if (r.ok) {
    write(statePath('merged', `${pr}-${sha}`), '');
    log(`PR #${pr} merged (${c.autoMerge})`);
    return;
  }
  // Not retried on this head: a merge that GitHub refused once refuses again until something changes.
  write(statePath('merge-failed', `${pr}-${sha}`), '');
  log(`PR #${pr} merge failed: ${r.err.split('\n')[0]}`);
}

/**
 * Trigger 8 — a PR that passed its final review is merged, with the `gh pr merge` method in `autoMerge`.
 * Off unless the user set one: merging is the last thing a human might want to keep. Everything has to
 * line up on the *current* head — the pass (`state/approved/<pr>-<sha>` plus the label), no review still
 * running, green or absent checks, and a clean merge — so a push after the pass, a red check or a conflict
 * all hold the merge until the card has been through trigger 5 (or 7) again.
 */
export async function autoMerge(board: BoardItem[]): Promise<void> {
  const c = cfg();
  const column = c.statusField.columns.approved;
  if (!c.autoMerge || !column.id) return;
  const issues = board.filter((i) => i.status === column.name && i.labels.includes(APPROVED_LABEL)).map((i) => i.number);
  for (const { pr, sha, checks, mergeable } of await wiredPrs(issues, { unapprovedOnly: false })) {
    const head = `${pr}-${sha}`;
    if (!fs.existsSync(statePath(MARKERS.approved, head)) || dirAlive(approvedDir(pr))) continue;
    if (fs.existsSync(statePath('merged', head)) || fs.existsSync(statePath('merge-failed', head))) continue;
    if (checks === 'FAILURE') say(head, `PR #${pr} is not merged: its checks fail`);
    else if (mergeable === 'CONFLICTING') say(head, `PR #${pr} is not merged: it conflicts with its base`);
    else if (checks !== 'PENDING' && mergeable === 'MERGEABLE') await merge(pr, sha);
  }
}
