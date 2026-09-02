import fs from 'node:fs';
import path from 'node:path';
import { cfg } from '../config';
import { freeIn, moveCard, pickupOrder, wiredPrs } from './board';
import type { BoardItem } from './board';
import { comment } from './gh';
import { limitExit } from './limits';
import { isDry, log, nowSec, readFile, readNumber, remove, write } from './log';
import { APPROVED_LABEL, MARKERS, markerFiles, skipped, statePath, unapprove } from './markers';
import { helpMentions, notify } from './notify';
import { cleanup, cleanupRun, keepWarm } from './cleanup';
import { exitLine, exitReport, exitsOf, forgetExits, recordExit } from './exits';
import { previewLink } from './preview';
import { forgetPause, pausedSeconds, resumeRun } from './pressure';
import { approvedDir, counter, dirAlive, dirOf, isBlocked, issueAlive, issueDir, pidAlive, pidOf, runDirs, startedAt, stateOf, triesOn } from './session-dirs';
import type { Kind } from './session-dirs';
import { launch, launchApproved } from './spawn';

const KILL_GRACE = 5 * 60; // extra time before Sloth kills a session that is past its budget
const LIMIT_PAUSE = 30 * 60; // how long the whole watcher sleeps after a usage-limit exit

export const pausedUntil = () => readNumber(statePath('paused_until'));

/**
 * Hands the issue to a human: one comment, then the needs-help column. Every way a run ends badly comes
 * through here — the budget, a stop from the monitor, too many relaunches, a PR closed unmerged — so this
 * is where the `stopped` webhook event is raised. `details` is markdown under the reason — the record of
 * how each run ended (`exits.ts`), so the human learns why without opening the logs; the record is
 * forgotten once it is posted.
 */
export async function park(issue: number, reason: string, details = ''): Promise<void> {
  const c = cfg();
  const cc = helpMentions();
  const body = `${c.botPrefix} ${reason} A developer needs to look at it: answer in this thread and Sloth continues, or move the card back to **${c.statusField.columns.pickup.name}** to start over.${details ? `\n\n${details}` : ''}${cc ? `\n\ncc ${cc}` : ''}`;
  if (isDry()) {
    log(`dry-run: would park #${issue} — ${reason}`);
    return;
  }
  await comment(c.repo, issue, body);
  const option = c.statusField.columns.needsHelp.id;
  // A move GitHub refused leaves the card in In Progress with its count cleared, where trigger 2 picks
  // it straight back up and parks it again `maxRetries` later — the same comment over and over, and
  // nothing ever escalating. It is parked where it stands instead, exactly as a board with no needs-help
  // column is: trigger 2 leaves a blocked card alone, trigger 6 still relaunches it on an answer, and
  // the marker goes with the next `launch`.
  if (!option || !(await moveCard(issue, option))) {
    write(path.join(issueDir(issue), 'blocked'), '1');
    log(`#${issue} parked in place (${option ? 'the card could not be moved' : 'no needs-help column configured'})`);
  }
  remove(path.join(issueDir(issue), 'retries'));
  forgetExits(issueDir(issue));
  await notify('stopped', { issue, text: `Sloth stopped work on #${issue}: ${reason}` });
}

/**
 * Ends one session. A live one loses its whole process group — the `claude` run and everything it
 * started — and its pid is forgotten so nothing reaps it twice; an issue's run is then cleaned up and
 * its card parked with `why` as the comment (left in In Progress, trigger 2 would only start it again),
 * a review keeps its "already reviewed this head" marker so the next push gets a fresh one — and, since
 * nothing will ever review that head again, the issue behind the PR is parked rather than left sitting in
 * Code Review with no verdict and nobody on it. A parked issue run whose process is already gone is ended
 * too: cleaned up and marked done, so it leaves the needs-help list; its card stays where it is, and an
 * answer on the issue starts a new run as before. Returns false when there was nothing to end.
 */
export async function stop(kind: Kind, target: number, reason: string, why: string): Promise<boolean> {
  const dir = dirOf(kind, target);
  const pid = pidOf(dir);
  const name = `${kind}-${target}`;
  if (!pidAlive(pid)) {
    const state = stateOf(dir);
    if (kind !== 'issue' || state.state !== 'waiting') return false;
    if (isDry()) {
      log(`dry-run: would end parked ${name}: ${reason}`);
      return true;
    }
    remove(path.join(dir, 'pid'));
    await cleanup(target);
    write(path.join(dir, 'state.json'), JSON.stringify({ ...state, state: 'done', since: nowSec(), note: `parked run ended: ${reason}` }));
    log(`#${target} parked run ended: ${reason}`);
    return true;
  }
  if (isDry()) {
    log(`dry-run: would stop ${name}: ${reason}`);
    return true;
  }
  // What the run was doing when it was killed is all the human will get: it never prints a final report.
  if (kind === 'issue') recordExit(dir, `stopped by Sloth: ${reason}`);
  // A run paused for the machine's sake is stopped cold: it has to be woken to act on the signal.
  resumeRun(dir);
  // Detached, so the run leads its own group: the negative pid takes its subagents and servers with it.
  for (const t of [-pid!, pid!]) {
    try {
      process.kill(t);
    } catch {
      /* raced with its own exit */
    }
  }
  remove(path.join(dir, 'pid'));
  if (kind === 'qa') {
    // Its app and worktree are its own; the card stays in QA and the head keeps its marker, like a stopped
    // review — except a budget kill, where `reap` drops the marker so the sweep tests the card again.
    // A killed run's database may hold a mutation it never finished: the stack warms the slot tainted,
    // so the next test of the card reseeds instead of trusting it.
    await cleanupRun('qa', target, true);
    log(`QA #${target} stopped: ${reason}`);
    return true;
  }
  if (kind !== 'issue') {
    log(`review PR #${target} stopped: ${reason}`);
    // The issue the PR is wired to, written beside the run by `launchApproved`; an older run has none.
    const issue = readNumber(path.join(dir, 'issue'));
    if (issue) await park(issue, `the review of PR #${target} was stopped: ${reason}.`);
    else log(`review PR #${target}: no issue recorded beside the run — its card is left where it is`);
    return true;
  }
  await cleanup(target, true);
  log(`#${target} stopped: ${reason}`);
  await park(target, why, exitReport(dir));
  return true;
}

/**
 * What a run that died before its own teardown leaves behind: its dev server, Redis and database, all
 * still up and holding the machine's memory and disk. An implement run or a QA test is cleaned up like
 * the session itself would have; a review starts nothing and has nothing to leave. An implement run
 * that ended with `preview.json` written is not swept — that app was handed over on purpose, and
 * `previews` tunnels it or, with previews off, cleans it up itself.
 */
async function sweepDead(kind: Kind, target: number): Promise<void> {
  if (kind === 'qa') {
    await cleanupRun('qa', target);
    return;
  }
  if (kind !== 'issue') return;
  const dir = issueDir(target);
  if (fs.existsSync(path.join(dir, 'preview.json')) || fs.existsSync(path.join(dir, 'preview-state.json'))) return;
  await cleanup(target);
}

/**
 * Forgets dead sessions, notices usage-limit exits, kills and cleans up hung ones. An issue run that died
 * while still `working` finished nothing: how it ended is recorded before trigger 2 relaunches it and
 * `launch` wipes its state, so the comment that finally parks the card can say what each run got to. One
 * that reached `done` finished, so it clears `retries` — the count is of crashes in a row, and a card that
 * comes back from a failing review is not one.
 * A review that died the same way posted no verdict, but `launchApproved` already marked its head as
 * reviewed — the marker goes, so trigger 4 gives the head the review it never got. A hung QA run is
 * killed with no verdict either, so its head marker goes the same way — `launchQa` counts the retry, and
 * the sweep gives the card up once they run out, instead of stranding it in QA with a head it never tested.
 */
export async function reap(): Promise<void> {
  for (const { kind, target, dir } of runDirs()) {
    const pidFile = path.join(dir, 'pid');
    if (!fs.existsSync(pidFile)) continue;
    const name = `${kind}-${target}`;
    if (!dirAlive(dir)) {
      remove(pidFile);
      forgetPause(dir);
      if (!limitExit(readFile(path.join(dir, 'run.log')))) {
        if ((stateOf(dir).state ?? 'working') === 'working') {
          if (kind === 'issue') {
            log(`${name} ended without finishing — ${exitLine(recordExit(dir, 'the session ended on its own'))}`);
          } else {
            for (const f of markerFiles(kind, target)) remove(statePath(MARKERS[kind], f));
            log(`${name} ended without a verdict — ${kind === 'qa' ? 'the card will be tested again' : 'the head will be reviewed again'}`);
          }
          await sweepDead(kind, target);
          // A run that finished on its own terms left its stack running for its slot — under the
          // warm-slots contract the session no longer kills its servers, so it moves to the slot here.
        } else {
          // …and it ends the crash count, which is what `retries` is: "relaunched without finishing, N
          // times in a row". A review that sends the card back to In Progress is not a crash, but trigger
          // 2 relaunches it and counts it all the same — three honest review round-trips on one issue used
          // to park the card saying the run "stopped without finishing 2 times in a row", with no exits to
          // show for it. Only `done` counts as finished: `waiting` is a run that stopped to ask.
          if (kind === 'issue' && stateOf(dir).state === 'done' && !isDry()) remove(path.join(dir, 'retries'));
          await keepWarm(kind, target);
        }
        continue;
      }
      log(`${name} stopped on a usage limit — pausing ${LIMIT_PAUSE / 60} min, card untouched`);
      write(statePath('paused_until'), String(nowSec() + LIMIT_PAUSE));
      await notify('usageLimit', {
        issue: kind === 'issue' ? target : undefined,
        text: `${name} stopped on a Claude usage limit — Sloth waits ${LIMIT_PAUSE / 60} minutes, the card keeps its place`,
      });
      if (kind !== 'issue') for (const f of markerFiles(kind, target)) remove(statePath(MARKERS[kind], f));
      await sweepDead(kind, target);
      continue;
    }
    const budget = (kind === 'qa' ? cfg().qa.budgetMinutes : cfg().budgetMinutes) * 60;
    // The time a run spent paused for the machine is not its own: the budget clock stands still meanwhile.
    if ((stateOf(dir).state ?? 'working') !== 'working' || nowSec() - startedAt(dir) - pausedSeconds(dir) <= budget + KILL_GRACE) continue;
    const stopped = await stop(kind, target, 'hung past the budget', 'the run for this issue hung past its time budget and was stopped by Sloth.');
    // A hang is not a verdict: the head's marker goes so the sweep tests the card again, `retries` allowing.
    if (stopped && kind === 'qa' && !isDry()) {
      for (const f of markerFiles(kind, target)) remove(statePath(MARKERS.qa, f));
      log(`QA #${target} will be tested again`);
    }
  }
}

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
 */
export async function reviews(board: BoardItem[]): Promise<void> {
  const col = cfg().statusField.columns;
  const inApproved = (i: BoardItem) => !!col.approved.id && i.status === col.approved.name;
  const cards = board.filter((i) => i.status === col.codeReview.name || inApproved(i));
  const perTick = Math.max(1, cfg().maxActive);
  let started = 0;
  for (const { issue, pr, sha, checks } of await wiredPrs(cards.map((i) => i.number))) {
    const marker = statePath(MARKERS.approved, `${pr}-${sha}`);
    if (fs.existsSync(marker) || dirAlive(approvedDir(pr))) continue;
    const card = cards.find((i) => i.number === issue);
    if (card && inApproved(card)) {
      if (issueAlive(issue)) continue;
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
    await comment(c.repo, issue, body);
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
      remove(path.join(issueDir(issue), 'handoff.md'));
    }
  }
}
