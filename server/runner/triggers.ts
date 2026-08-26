import fs from 'node:fs';
import path from 'node:path';
import { cfg } from '../config';
import { moveCard, unassignedIn, wiredPrs } from './board';
import type { BoardItem } from './board';
import { comment, run } from './gh';
import { limitExit } from './limits';
import { isDry, log, nowSec, readFile, readNumber, remove, write } from './log';
import { approvedDir, counter, dirAlive, isBlocked, issueAlive, issueDir, reviewDir, runDirs, startedAt, stateOf } from './session-dirs';
import type { Kind } from './session-dirs';
import { launch, launchApproved, launchReview } from './spawn';

const KILL_GRACE = 5 * 60; // extra time before Sloth kills a session that is past its budget
const LIMIT_PAUSE = 30 * 60; // how long the whole watcher sleeps after a usage-limit exit

const statePath = (...parts: string[]) => path.join(cfg().stateDir, ...parts);
export const pausedUntil = () => readNumber(statePath('paused_until'));

/** What the session's own cleanup step would have done, for a run that never got there. */
async function cleanup(issue: number): Promise<void> {
  const dir = issueDir(issue);
  for (const name of ['dev.pid', 'redis.pid']) {
    const file = path.join(dir, name);
    // One pid per line — a project skill may have started several servers.
    for (const line of (readFile(file) ?? '').split('\n')) {
      const pid = Number(line.trim());
      if (!pid) continue;
      try {
        process.kill(pid);
      } catch {
        /* already gone */
      }
    }
    remove(file);
  }
  const db = readFile(path.join(dir, 'demo.db'))?.trim();
  if (db) {
    await run('dropdb', ['--if-exists', db], 60_000);
    remove(path.join(dir, 'demo.db'));
  }
  const worktree = path.join(cfg().worktreesDir, `issue-${issue}`);
  if (fs.existsSync(worktree)) {
    await run('git', ['-C', cfg().runnerRoot, 'worktree', 'remove', worktree, '--force'], 120_000);
    await run('git', ['-C', cfg().runnerRoot, 'worktree', 'prune'], 60_000);
  }
}

/** Hands the issue to a human: one comment, then the needs-help column. */
export async function park(issue: number, reason: string): Promise<void> {
  const c = cfg();
  const body = `${c.botPrefix} ${reason} A developer needs to look at it; move the card back to **${c.statusField.columns.pickup.name}** to retry.`;
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
  remove(path.join(issueDir(issue), 'kills'));
  remove(path.join(issueDir(issue), 'retries'));
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
    try {
      process.kill(readNumber(pidFile));
    } catch {
      /* raced with its own exit */
    }
    remove(pidFile);
    if (kind !== 'issue') {
      log(`${kind === 'review' ? 'review' : 'final review'} PR #${target} killed: hung past the budget`);
      continue;
    }
    await cleanup(target);
    const kills = counter(dir, 'kills') + 1;
    write(path.join(dir, 'kills'), String(kills));
    log(`#${target} killed: hung past the budget (kill ${kills})`);
    if (kills >= 2) await park(target, 'the run for this issue hung past its time budget twice and was stopped by Sloth.');
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

/** Trigger 4 — Code Review cards whose wired PR is open and unapproved get one review per PR head. */
export async function reviews(board: BoardItem[]): Promise<void> {
  const issues = unassignedIn(board, cfg().statusField.columns.codeReview.name);
  for (const { issue, pr, sha } of await wiredPrs(issues)) {
    const marker = statePath(MARKERS.review, `${pr}-${sha}`);
    if (fs.existsSync(marker) || dirAlive(reviewDir(pr))) continue;
    if (launchReview(pr, issue) && !isDry()) write(marker, '');
  }
}

/**
 * Trigger 5 — Approved cards whose wired PR is open get one final review per PR head, with the
 * project's own review command on `approvedModel`. A GitHub approval does not exclude the PR here:
 * the column is the signal. No Approved column configured → nothing to do.
 */
export async function finalReviews(board: BoardItem[]): Promise<void> {
  const column = cfg().statusField.columns.approved;
  if (!column.id) return;
  const issues = unassignedIn(board, column.name);
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
