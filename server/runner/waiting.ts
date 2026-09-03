import path from 'node:path';
import { nowSec, readNumber, remove, write } from './log';
import { stateOf } from './session-dirs';

/**
 * A session that stopped to ask (`waiting`) is not spending its budget: the clock stands still while the
 * question is open, exactly as it does while the run is paused for the machine (`pressure.ts`), and a run
 * that got its answer has the 30 minutes the session skill promises it at least. Before this the server
 * measured from launch and subtracted only pause time, so a question that took most of an hour to answer
 * got its run killed as "hung" minutes after it had thanked the developer and continued.
 *
 * The ledger is the server's own: `waiting` holds when *the server* first saw the state, `waiting_total`
 * the seconds credited so far and `answered` when it last saw the run working again. The session's
 * `since` is not consulted — it cannot move its own deadline, which is what `launchedAt` is about — so a
 * wait is counted to the tick, never to the second.
 */

/** How long a run has at least once its answer arrives, whatever its budget says — the skill's own floor. */
export const ANSWER_MINUTES = 30;

const file = (dir: string) => path.join(dir, 'waiting');
const totalFile = (dir: string) => path.join(dir, 'waiting_total');
const answeredFile = (dir: string) => path.join(dir, 'answered');

/** Notices a live run entering or leaving `waiting`; called on every tick for every run still alive. */
export function trackWaiting(dir: string): void {
  const since = readNumber(file(dir));
  const waiting = stateOf(dir).state === 'waiting';
  if (waiting && !since) write(file(dir), String(nowSec()));
  else if (!waiting && since) {
    write(totalFile(dir), String(readNumber(totalFile(dir)) + Math.max(0, nowSec() - since)));
    write(answeredFile(dir), String(nowSec()));
    remove(file(dir));
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
