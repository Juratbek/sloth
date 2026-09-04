import path from 'node:path';
import { cfg } from '../config';
import { snapshot } from './board-snapshot';
import { nowSec, readNumber, remove, write } from './log';
import { launchedAt, stateOf } from './session-dirs';

/**
 * A session that stopped to ask (`waiting`) is not spending its budget, and is not working hours the
 * client pays for: the clock stands still while the question is open, exactly as it does while the run
 * is paused for the machine (`pressure.ts`), and a run that got its answer has the 30 minutes the session
 * skill promises it at least. Before this the server measured from launch and subtracted only pause
 * time, so a question that took most of an hour to answer got its run killed as "hung" minutes after it
 * had thanked the developer and continued.
 *
 * The ledger is the server's own: `waiting` holds when the wait began, `waiting_total` the seconds
 * credited so far and `answered` when the server last saw the run working again. A run is waiting when
 * it says so in its state, or when its card stands in the needs-help column on the board the loop last
 * read — the column is the rule the client is billed by, and it holds even for a session that moved the
 * card and forgot to say so. Where the wait *began* is taken from the session's own marks when they are
 * ones it could have written honestly — after the launch, after its last answer, not in the future:
 * `since` when it said it was asking, `asked_at` (written when it posted the question) when only the
 * board says so — and from the tick otherwise. The tick is five minutes wide, and the minutes between the
 * question and the tick that noticed it would be billed as work; a question answered inside one tick
 * would never be noticed at all, so a run seen working with an `asked_at` newer than its last answer is
 * credited that wait too. A wrong mark can only shorten the bill, never the deadline: `launchedAt` is
 * what the budget is measured from, and that the session cannot move.
 */

/** How long a run has at least once its answer arrives, whatever its budget says — the skill's own floor. */
export const ANSWER_MINUTES = 30;

const file = (dir: string) => path.join(dir, 'waiting');
const totalFile = (dir: string) => path.join(dir, 'waiting_total');
const answeredFile = (dir: string) => path.join(dir, 'answered');

/** Whether the card for `issue` stood in the needs-help column when the loop last read the board. */
function parkedOnBoard(issue: number | undefined): boolean {
  if (!issue) return false;
  const column = cfg().statusField.columns.needsHelp.name;
  if (!column) return false;
  return snapshot()?.items.some((i) => i.number === issue && i.status === column) ?? false;
}

/** A mark of the session's, if it lies in the run's own life: after the launch and its last answer, not in the future. */
function honest(dir: string, mark: number, now: number): number | undefined {
  const floor = Math.max(launchedAt(dir), answeredAt(dir));
  return mark > floor && mark <= now ? mark : undefined;
}

/** Books a wait that ran from `from` to `to`, and remembers when the run was last seen working. */
function credit(dir: string, from: number, to: number): void {
  write(totalFile(dir), String(readNumber(totalFile(dir)) + Math.max(0, to - from)));
  write(answeredFile(dir), String(to));
}

/**
 * Notices a live run entering or leaving `waiting`; called on every tick for every run still alive.
 * `issue` is the card the run works for, for the board's word on whether it is parked.
 */
export function trackWaiting(dir: string, issue?: number): void {
  const since = readNumber(file(dir));
  const now = nowSec();
  const state = stateOf(dir);
  const said = state.state === 'waiting';
  const waiting = said || parkedOnBoard(issue);
  if (waiting && !since) {
    // The session's `since` counts only when it said it was asking; `asked_at` it wrote when it posted the
    // question, whatever it said afterwards. Neither, and the wait began when the board was last read.
    const asked = honest(dir, readNumber(path.join(dir, 'asked_at')), now);
    const began = (said ? honest(dir, Number(state.since) || 0, now) : undefined) ?? asked ?? Math.min(now, Math.floor((snapshot()?.at ?? Infinity) / 1000));
    write(file(dir), String(began));
  } else if (!waiting && since) {
    credit(dir, since, now);
    remove(file(dir));
  } else if (!waiting) {
    // Asked and answered between two ticks: the session's own marks are all there is, and they only credit.
    const asked = honest(dir, readNumber(path.join(dir, 'asked_at')), now);
    const resumed = honest(dir, Number(state.since) || 0, now);
    if (asked && resumed && resumed > asked) credit(dir, asked, resumed);
  }
}

/**
 * Seconds this run has spent waiting for an answer so far — its budget clock does not tick meanwhile. Up
 * to `until` when the ledger books a run that ended before the tick noticed: a wait still open then
 * counts only to that moment.
 */
export function waitedSeconds(dir: string, until = nowSec()): number {
  const since = readNumber(file(dir));
  return readNumber(totalFile(dir)) + (since ? Math.max(0, Math.min(until, nowSec()) - since) : 0);
}

/** When the run last went from `waiting` back to work, or 0 if it never asked. */
export const answeredAt = (dir: string): number => readNumber(answeredFile(dir));

/** Forgets a run's waiting bookkeeping — a new run on the issue starts with a full clock. */
export function forgetWaiting(dir: string): void {
  remove(file(dir));
  remove(totalFile(dir));
  remove(answeredFile(dir));
}
