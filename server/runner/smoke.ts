import fs from 'node:fs';
import path from 'node:path';
import { cfg } from '../config';
import { isDry, log, nowSec, readFile, readNumber, remove, write } from './log';
import { statePath } from './markers';
import { notify } from './notify';
import { headOf, localDate, pastTime } from './qa';
import { dirAlive, runDirs } from './session-dirs';
import { launchSmoke } from './spawn-tests';

/**
 * Trigger 11 — the scheduled smoke test. Every `smoke.everyDays` days, at `smoke.at` on this machine's
 * clock, one session — `/sloth:smoke <n>` on `models.smoke` — checks `smoke.branch` out at its current
 * head, boots the app and has a browser tester walk the main flows of every user role, happy paths only,
 * the way a release is qualified before a deploy: broken login, a white screen, a core flow that cannot
 * complete. It ends with a GO / NO-GO report on a report issue in the repository, the serious findings
 * filed as issues of their own, and one word for the server in `verdict`. Nothing moves on the board:
 * the report is the product, and the webhook hears which way it went (`smokePassed` / `smokeFailed`).
 *
 * The run is its own: `smoke-<n>`, `n` counted up in `state/smoke_seq`, since it works for no card. One
 * at a time — a run asked for while one is going is dropped, not queued behind it — and a run that is
 * due but held (the slots, the machine) stays due until it starts. `state/smoke_ran` holds the date of
 * the last scheduled start, so "every two days" is measured on the calendar from there; a run from the
 * monitor's button (`state/smoke_due`) counts for the day only when the day was due anyway.
 */

/** The date of the last scheduled start, `YYYY-MM-DD` on this machine's clock. */
const ranFile = () => statePath('smoke_ran');
/** A run asked for from the monitor, waiting for the tick that starts it. */
const dueFile = () => statePath('smoke_due');
/** The number the last run got. */
const seqFile = () => statePath('smoke_seq');

const VERDICTS: Record<string, string> = { go: 'GO', 'go-with-risks': 'GO with risks', 'no-go': 'NO-GO', inconclusive: 'inconclusive' };
/** The verdicts that mean the branch may ship; anything else — including a word nobody defined — does not. */
const PASSING = ['go', 'go-with-risks'];

/** Whole days between two `YYYY-MM-DD` dates, on the calendar — a clock change in between makes no half day. */
export function daysBetween(from: string, to: string): number {
  const utc = (d: string) => {
    const [y, m, day] = d.split('-').map(Number);
    return Date.UTC(y, m - 1, day);
  };
  return Math.round((utc(to) - utc(from)) / 86_400_000);
}

/** Whether the schedule asks for a run now: it is on, the hour has passed, and `everyDays` have gone by since the last scheduled start. */
export function smokeDue(now = new Date()): boolean {
  const { everyDays, at } = cfg().smoke;
  if (everyDays < 1 || !at || !pastTime(at, now)) return false;
  const last = readFile(ranFile())?.trim();
  return !last || !/^\d{4}-\d{2}-\d{2}$/.test(last) || daysBetween(last, localDate(now)) >= everyDays;
}

/** "Test now" from the monitor: a run on the next tick, whatever the schedule says. */
export function requestSmoke(): void {
  if (isDry()) {
    log('dry-run: would ask for a smoke test');
    return;
  }
  write(dueFile(), String(nowSec()));
  log('smoke test asked for from the monitor');
}
export const smokeRequested = (): boolean => fs.existsSync(dueFile());

/** Whether a smoke test is running now. */
export const smokeAlive = (): boolean => runDirs().some((d) => d.kind === 'smoke' && dirAlive(d.dir));

/** Starts the smoke test when it is due or asked for, and nothing else is running one. */
export async function smokeTick(): Promise<void> {
  const forced = smokeRequested();
  const due = smokeDue();
  if (!forced && !due) return;
  if (smokeAlive()) {
    // The one going answers the request; the schedule's own turn waits for it to end.
    if (forced) {
      log('smoke test: one is already running — the request is dropped');
      if (!isDry()) remove(dueFile());
    }
    return;
  }
  const head = await headOf(cfg().smoke.branch, 'smoke test');
  if (!head) return;
  const n = readNumber(seqFile()) + 1;
  if (!(await launchSmoke(n, head.sha, head.branch))) return;
  if (isDry()) return;
  write(seqFile(), String(n));
  if (forced) remove(dueFile());
  // A run that was due either way is the day's scheduled one, whoever pressed the button.
  if (due) write(ranFile(), localDate());
}

/**
 * The verdict a finished smoke test wrote, told once (`handled`): the log, and the webhook with the
 * report issue's link when the session recorded one (`report_issue`). A run with no verdict died, and
 * `reap` has said so.
 */
export async function smokeVerdicts(): Promise<void> {
  for (const { kind, target: n, dir } of runDirs()) {
    if (kind !== 'smoke' || dirAlive(dir) || fs.existsSync(path.join(dir, 'handled'))) continue;
    const verdict = readFile(path.join(dir, 'verdict'))?.trim();
    if (!verdict) continue;
    const branch = readFile(path.join(dir, 'branch'))?.trim() || 'the default branch';
    const sha = (readFile(path.join(dir, 'sha')) ?? '').trim().slice(0, 7);
    const where = `${branch}${sha ? ` @ ${sha}` : ''}`;
    const issue = readNumber(path.join(dir, 'report_issue')) || undefined;
    const said = VERDICTS[verdict] ?? verdict;
    log(`smoke test ${n}: ${said} on ${where}${issue ? ` — the report is on #${issue}` : ''}`);
    await notify(PASSING.includes(verdict) ? 'smokePassed' : 'smokeFailed', { issue, text: `Smoke test ${n} on ${where}: ${said}` });
    if (!isDry()) write(path.join(dir, 'handled'), '');
  }
}
