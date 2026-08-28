import fs from 'node:fs';
import path from 'node:path';
import { cfg } from '../config';
import { moveCard, unassignedIn, wiredPrs } from './board';
import type { BoardItem } from './board';
import { comment } from './gh';
import { limitExit } from './limits';
import { isDry, log, nowSec, readFile, readNumber, remove, write } from './log';
import { helpMentions } from './notify';
import { cleanup } from './cleanup';
import { approvedDir, counter, dirAlive, dirOf, isBlocked, issueAlive, issueDir, pidAlive, pidOf, reviewDir, runDirs, startedAt, stateOf } from './session-dirs';
import type { Kind } from './session-dirs';
import { launch, launchApproved, launchReview } from './spawn';

const KILL_GRACE = 5 * 60; // extra time before Sloth kills a session that is past its budget
const LIMIT_PAUSE = 30 * 60; // how long the whole watcher sleeps after a usage-limit exit

const statePath = (...parts: string[]) => path.join(cfg().stateDir, ...parts);
export const pausedUntil = () => readNumber(statePath('paused_until'));

/** Hands the issue to a human: one comment, then the needs-help column. */
export async function park(issue: number, reason: string): Promise<void> {
  const c = cfg();
  const cc = helpMentions();
  const body = `${c.botPrefix} ${reason} A developer needs to look at it: answer in this thread and Sloth continues, or move the card back to **${c.statusField.columns.pickup.name}** to start over.${cc ? `\n\ncc ${cc}` : ''}`;
  if (isDry()) {
    log(`dry-run: would park #${issue} — ${reason}`);
    return;
  }
  await comment(c.repo, issue, body);
  const option = c.statusField.columns.needsHelp.id;
  if (option) await moveCard(issue, option);
  else {
    write(path.join(issueDir(issue), 'blocked'), '1');
    log(`#${issue} parked in place (no needs-help column configured)`);
  }
  remove(path.join(issueDir(issue), 'retries'));
}

/**
 * Ends one live session. Its whole process group goes — the `claude` run and everything it started —
 * and the pid is forgotten so nothing reaps it twice. An issue's run is also cleaned up and its card
 * parked with `why` as the comment: left in In Progress, trigger 2 would only start it again. A review
 * keeps its "already reviewed this head" marker; the next push gets a fresh review. Returns false
 * when nothing was running.
 */
export async function stop(kind: Kind, target: number, reason: string, why: string): Promise<boolean> {
  const dir = dirOf(kind, target);
  const pid = pidOf(dir);
  if (!pidAlive(pid)) return false;
  const name = `${kind}-${target}`;
  if (isDry()) {
    log(`dry-run: would stop ${name}: ${reason}`);
    return true;
  }
  // Detached, so the run leads its own group: the negative pid takes its subagents and servers with it.
  for (const t of [-pid!, pid!]) {
    try {
      process.kill(t);
    } catch {
      /* raced with its own exit */
    }
  }
  remove(path.join(dir, 'pid'));
  if (kind !== 'issue') {
    log(`${kind === 'review' ? 'review' : 'final review'} PR #${target} stopped: ${reason}`);
    return true;
  }
  await cleanup(target);
  log(`#${target} stopped: ${reason}`);
  await park(target, why);
  return true;
}

/** Forgets dead sessions, notices usage-limit exits, kills and cleans up hung ones. */
export async function reap(): Promise<void> {
  for (const { kind, target, dir } of runDirs()) {
    const pidFile = path.join(dir, 'pid');
    if (!fs.existsSync(pidFile)) continue;
    const name = `${kind}-${target}`;
    if (!dirAlive(dir)) {
      remove(pidFile);
      if (!limitExit(readFile(path.join(dir, 'run.log')))) continue;
      log(`${name} stopped on a usage limit — pausing ${LIMIT_PAUSE / 60} min, card untouched`);
      write(statePath('paused_until'), String(nowSec() + LIMIT_PAUSE));
      if (kind !== 'issue') for (const f of markerFiles(kind, target)) remove(statePath(MARKERS[kind], f));
      continue;
    }
    const budget = cfg().budgetMinutes * 60;
    if ((stateOf(dir).state ?? 'working') !== 'working' || nowSec() - startedAt(dir) <= budget + KILL_GRACE) continue;
    await stop(kind, target, 'hung past the budget', 'the run for this issue hung past its time budget and was stopped by Sloth.');
  }
}

/** Where each review kind keeps its `<pr>-<sha>` "already reviewed this head" markers. */
const MARKERS: Record<Exclude<Kind, 'issue'>, string> = { review: 'reviewed', approved: 'approved' };

function markerFiles(kind: Exclude<Kind, 'issue'>, pr: number): string[] {
  try {
    return fs.readdirSync(statePath(MARKERS[kind])).filter((f) => f.startsWith(`${pr}-`));
  } catch {
    return [];
  }
}

/** The branches `/sloth:implement` pushes to — its reviewer loop already vetted that head before the hand-off. */
const OWN_BRANCH = /^sloth\/issue-\d+/;

/**
 * Trigger 4 — Code Review cards whose wired PR is open and unapproved get one review per PR head.
 * Sloth's own PRs are skipped: the implement session's reviewer loop passed on exactly that head,
 * so a second `/sloth:review` would only repeat it. Human-written PRs are what this trigger is for.
 */
export async function reviews(board: BoardItem[]): Promise<void> {
  const issues = unassignedIn(board, cfg().statusField.columns.codeReview.name);
  for (const { issue, pr, sha, head } of await wiredPrs(issues)) {
    if (OWN_BRANCH.test(head)) continue;
    const marker = statePath(MARKERS.review, `${pr}-${sha}`);
    if (fs.existsSync(marker) || dirAlive(reviewDir(pr))) continue;
    if (launchReview(pr, issue) && !isDry()) write(marker, '');
  }
}

/** The label `/sloth:review <pr> final` puts on a wired issue whose PR passed; a failing final review removes it. */
const APPROVED_LABEL = 'Fable: approved';

/**
 * Trigger 5 — Approved cards whose wired PR is open get one final review per PR head, with
 * `/sloth:review <pr> final` on `models.final`; a pass labels the issue `Fable: approved`, and a card
 * carrying that label is done — it is not reviewed again until the label goes (a failing review removes
 * it; a human can too). Neither a GitHub approval nor an assignee excludes the PR: the column is the
 * signal. A rejected assigned card goes back to In Progress with its assignee intact, so the human keeps
 * it (trigger 2 skips it). No Approved column configured → nothing to do.
 */
export async function finalReviews(board: BoardItem[]): Promise<void> {
  const column = cfg().statusField.columns.approved;
  if (!column.id) return;
  const issues = board.filter((i) => i.status === column.name && !i.labels.includes(APPROVED_LABEL)).map((i) => i.number);
  for (const { issue, pr, sha } of await wiredPrs(issues, { unapprovedOnly: false })) {
    const marker = statePath(MARKERS.approved, `${pr}-${sha}`);
    if (fs.existsSync(marker) || dirAlive(approvedDir(pr))) continue;
    if (launchApproved(pr, issue) && !isDry()) write(marker, '');
  }
}

/** Trigger 2 — In Progress cards with no live session: a reboot or a usage-limit retry, capped. */
export async function retryStranded(board: BoardItem[]): Promise<void> {
  for (const issue of unassignedIn(board, cfg().statusField.columns.inProgress.name)) {
    if (issueAlive(issue) || isBlocked(issueDir(issue))) continue;
    const retries = counter(issueDir(issue), 'retries');
    if (retries >= cfg().maxRetries) {
      await park(issue, `the run for this issue stopped without finishing ${retries} times in a row.`);
      continue;
    }
    if (!(await launch(issue))) break;
    if (!isDry()) write(path.join(issueDir(issue), 'retries'), String(retries + 1));
  }
}

/** Trigger 1 — the watched column, in board order. A fresh pickup resets the retry counter. */
export async function pickup(board: BoardItem[]): Promise<void> {
  for (const issue of unassignedIn(board, cfg().statusField.columns.pickup.name)) {
    if (issueAlive(issue)) continue;
    if (!(await launch(issue))) break;
    if (!isDry()) remove(path.join(issueDir(issue), 'retries'));
  }
}
