import fs from 'node:fs';
import path from 'node:path';
import { cfg } from '../config';
import { moveCard, reviewVerdict } from './board';
import { cleanup, cleanupRun, keepWarm } from './cleanup';
import type { HoursEnding } from '../hours-types';
import { bookRun, budgetOf, KILL_GRACE } from './hours';
import { exitLine, exitReport, forgetExits, recordExit } from './exits';
import { comment } from './gh';
import { killTree } from './kill';
import { usageLimit } from './limits';
import { isDry, log, nowSec, readFile, readNumber, remove, write } from './log';
import { MARKERS, markerFiles, statePath } from './markers';
import { helpMentions, notify } from './notify';
import { forgetPause, pausedSeconds, resumeRun } from './pressure';
import { dirAlive, dirOf, issueDir, launchedAt, pidAlive, pidOf, predatesBoot, runDirs, stateOf } from './session-dirs';
import type { Kind } from './session-dirs';
import { ANSWER_MINUTES, answeredAt, forgetWaiting, trackWaiting, waitedSeconds } from './waiting';

/**
 * A run's life after it has started: parking the card a run could not finish, stopping a run on demand,
 * and the reaping every tick opens with — forgetting the dead, killing the hung, cleaning up what either
 * left behind. `triggers.ts` is about what the *board* asks Sloth to start; this is about what happens to
 * a session once it is Sloth's, and the two only meet at `park`, which every bad ending goes through.
 */

const LIMIT_PAUSE = 30 * 60; // how long the whole watcher sleeps after a usage-limit exit
/** The reason `reap` stops a hung run with — the one stop the ledger books as `budget` rather than `stopped`. */
export const BUDGET_REASON = 'hung past the budget';

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
    // A pid file still here means `reap` has not booked this run yet — it stopped to ask, and is billed as
    // such. Reap takes the file with the booking, so a run it already booked is not booked a second time.
    if (fs.existsSync(path.join(dir, 'pid'))) {
      bookRun(kind, target, dir, 'waiting');
      remove(path.join(dir, 'pid'));
      forgetPause(dir);
      forgetWaiting(dir);
    }
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
  // A killed run's hours are not billed, whoever killed it: the budget is Sloth's own failing, and a stop
  // from the monitor is the human's call. Booked while `pid` and the pause files are still there.
  bookRun(kind, target, dir, reason === BUDGET_REASON ? 'budget' : 'stopped');
  // A run paused for the machine's sake is stopped cold: it has to be woken to act on the signal.
  resumeRun(dir);
  // Detached, so the run leads its own group — and on Windows a tree `taskkill` walks (`kill.ts`): either
  // way its subagents, servers and browser go with it.
  await killTree(pid!);
  remove(path.join(dir, 'pid'));
  if (kind === 'qa' || kind === 'smoke') {
    // Its app and worktree are its own; the card stays in QA and the head keeps its marker, like a stopped
    // review — except a budget kill, where `reap` drops the marker so the sweep tests the card again.
    // A killed run's database may hold a mutation it never finished: the stack warms the slot tainted,
    // so the next test of the card reseeds instead of trusting it. A smoke test has no card and no
    // marker: stopped, it is over, and the next scheduled one runs when it is due.
    await cleanupRun(kind, target, true);
    log(`${kind === 'qa' ? `QA #${target}` : `smoke test ${target}`} stopped: ${reason}`);
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
  if (kind === 'qa' || kind === 'smoke') {
    await cleanupRun(kind, target);
    return;
  }
  if (kind !== 'issue') return;
  const dir = issueDir(target);
  if (fs.existsSync(path.join(dir, 'preview.json')) || fs.existsSync(path.join(dir, 'preview-state.json'))) return;
  await cleanup(target);
}

/**
 * Whether a review run that ended still `working` did in fact finish: its verdict is on the PR, for the
 * head it was started on (`launchApproved` writes that beside the run). The review command has no
 * teardown of its own to speak of, and a run that skipped `set_state done` used to read as "died without
 * a verdict": `reap` dropped the head's marker, trigger 4 saw an Approved card with an unreviewed head,
 * took the label and the card back and reviewed the same commit again — six passes in half an hour on one
 * PR, then a park for "no verdict". The PR is the record that cannot be skipped, so it is asked first.
 */
async function verdictPosted(kind: Kind, target: number, dir: string): Promise<boolean> {
  if (kind !== 'approved') return false;
  const sha = (readFile(path.join(dir, 'sha')) ?? '').trim();
  if (!sha) return false;
  const verdict = await reviewVerdict(target, sha);
  if (!verdict) return false;
  log(`review PR #${target} ended without marking itself done, but its verdict (${verdict}) is on the PR — head ${sha.slice(0, 7)} stays reviewed`);
  return true;
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
      const limit = usageLimit(dir);
      const { state, step } = stateOf(dir);
      // The run's hours are booked before its files go: how it ended decides whether they are billed. A
      // run `done` at the question step (`Q`) asked and gave up when `waitHours` passed with no answer.
      // Only the two states the skill defines count as finished: anything else a session wrote is a run
      // that ended working — never billed on a word nobody defined.
      const said = state === 'done' || state === 'waiting';
      const finished = said || (!limit && (await verdictPosted(kind, target, dir)));
      const ending: HoursEnding = limit ? 'usageLimit' : state === 'done' ? (step === 'Q' ? 'noResponse' : 'done') : state === 'waiting' ? 'waiting' : finished ? 'verdict' : predatesBoot(pidFile) ? 'rebooted' : 'died';
      bookRun(kind, target, dir, ending);
      // A dry tick booked nothing, so it forgets nothing: the real tick after it books the run once.
      if (!isDry()) {
        remove(pidFile);
        forgetPause(dir);
        forgetWaiting(dir);
      }
      if (!limit) {
        if (!finished) {
          if (kind === 'issue') {
            log(`${name} ended without finishing — ${exitLine(recordExit(dir, 'the session ended on its own'))}`);
          } else {
            for (const f of markerFiles(kind, target)) remove(statePath(MARKERS[kind], f));
            log(`${name} ended without a verdict — ${kind === 'qa' ? 'the card will be tested again' : kind === 'smoke' ? 'the next scheduled smoke test runs as planned' : 'the head will be reviewed again'}`);
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
      // Which of the two signals fired is in the line: the transcript's own error entry, or the CLI's prose.
      log(`${name} stopped on a usage limit (${limit}) — pausing ${LIMIT_PAUSE / 60} min, card untouched`);
      if (!isDry()) write(statePath('paused_until'), String(nowSec() + LIMIT_PAUSE));
      await notify('usageLimit', {
        issue: kind === 'issue' ? target : undefined,
        text: `${name} stopped on a Claude usage limit — Sloth waits ${LIMIT_PAUSE / 60} minutes, the card keeps its place`,
      });
      if (kind !== 'issue') for (const f of markerFiles(kind, target)) remove(statePath(MARKERS[kind], f));
      await sweepDead(kind, target);
      continue;
    }
    // An issue run's card is the board's word on whether it is parked; a review or QA run never parks.
    trackWaiting(dir, kind === 'issue' ? target : undefined);
    const budget = budgetOf(kind) * 60;
    // The time a run spent paused for the machine, or parked waiting for an answer, is not its own: the
    // budget clock stands still meanwhile. And a run that got its answer keeps the skill's promise — the
    // session gives itself `max(remaining, 30 min)` then, so the server allows no less.
    const deadline = Math.max(launchedAt(dir) + pausedSeconds(dir) + waitedSeconds(dir) + budget, answeredAt(dir) + ANSWER_MINUTES * 60);
    if ((stateOf(dir).state ?? 'working') !== 'working' || nowSec() <= deadline + KILL_GRACE) continue;
    const stopped = await stop(kind, target, BUDGET_REASON, 'the run for this issue hung past its time budget and was stopped by Sloth.');
    // A hang is not a verdict: the head's marker goes so the sweep tests the card again, `retries` allowing.
    if (stopped && kind === 'qa' && !isDry()) {
      for (const f of markerFiles(kind, target)) remove(statePath(MARKERS.qa, f));
      log(`QA #${target} will be tested again`);
    }
  }
}
