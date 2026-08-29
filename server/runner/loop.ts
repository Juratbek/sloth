import { cfg } from '../config';
import { broadcast } from '../events';
import { fetchBoard } from './board';
import { setSnapshot } from './board-snapshot';
import { refreshColumns } from './columns';
import { comments } from './comments';
import { autoMerge, failedChecks, finished } from './lifecycle';
import { isDry, log, nowSec, setDry } from './log';
import { boardEvents } from './notify-events';
import { sampleMachine } from './machine';
import { isPaused } from './pause';
import { previews } from './preview';
import { qaSweep, qaVerdicts } from './qa';
import { prune } from './retention';
import { answered } from './answers';
import { handover, pausedUntil, pickup, reap, retryStranded, reviews } from './triggers';
import type { LoopStatus } from '../types';

export interface TickOptions {
  board?: boolean;
  comments?: boolean;
  dryRun?: boolean;
}

const state: LoopStatus = { running: false, ticking: false };
const timers: Partial<Record<'board' | 'comments', NodeJS.Timeout>> = {};
let chain: Promise<unknown> = Promise.resolve();

/** One pass. Ticks never overlap: every caller is queued behind the one in flight. */
export function tick(options: TickOptions = { board: true, comments: true }): Promise<void> {
  const queued = chain.then(() => runTick(options)).catch((e) => log(`tick failed: ${e}`));
  chain = queued;
  return queued;
}

async function runTick({ board = false, comments: wantComments = false, dryRun = false }: TickOptions): Promise<void> {
  const was = isDry();
  if (dryRun) setDry(true);
  state.ticking = true;
  try {
    await reap();
    // Previews are finished work, not new work: they run even while paused.
    await previews();
    await refreshColumns();
    const paused = pausedUntil();
    if (nowSec() < paused) {
      log(`paused until ${new Date(paused * 1000).toISOString()} (usage limit)`);
      return;
    }
    // A user pause stops the launching triggers only: replies and deliveries are not new work.
    const userPaused = isPaused();
    if (userPaused) log('paused — no new work (reap, inbox delivery and status replies still run)');
    // Both kinds of tick may launch (an order does, from a comment): read the machine before either.
    else {
      const machine = await sampleMachine();
      if (machine.hold && machine.hold !== state.machine?.hold) log(`${machine.hold} — no new sessions until it clears`);
      else if (!machine.hold && state.machine?.hold) log('machine load cleared — new sessions may start');
      state.machine = machine;
    }
    if (wantComments) {
      state.lastComment = Date.now();
      await comments();
    }
    if (!board) return;
    state.lastBoard = Date.now();
    // Housekeeping on work that is long over — it costs nothing and skips itself for an hour.
    await prune();
    const items = await fetchBoard();
    if (!items) return;
    // The home panel's board view mirrors this one read — a dry run reads the board too, and reading is harmless.
    setSnapshot(items);
    // Filing a closed issue away is bookkeeping on work that is already over, not new work — and so is
    // moving a card on the verdict its QA test left behind.
    await finished(items);
    await qaVerdicts();
    // The webhook hears about all of it even while paused: sessions keep running, so they keep parking.
    await boardEvents(items);
    if (userPaused) return;
    // The review first: a card in Code Review is finished work waiting on a short look, so it goes ahead
    // of everything that starts a build — a red check, a stranded card, an order, the pickup column.
    await reviews(items);
    await failedChecks(items);
    await handover(items);
    await autoMerge(items);
    await retryStranded(items);
    await answered(items);
    // The day's QA sweep, when it is time: the merged fixes waiting in QA are tested before new ones are started.
    await qaSweep(items);
    await pickup(items);
  } finally {
    state.ticking = false;
    setDry(was);
    broadcast();
  }
}

const intervalOf = (kind: 'board' | 'comments') => (kind === 'board' ? cfg().boardSeconds : cfg().commentSeconds);

/** Re-arms itself after every run, so a slow tick delays the next one instead of stacking up. */
function schedule(kind: 'board' | 'comments', delaySeconds: number): void {
  const at = Date.now() + delaySeconds * 1000;
  if (kind === 'board') state.nextBoard = at;
  else state.nextComment = at;
  timers[kind] = setTimeout(() => {
    if (!state.running) return;
    void tick(kind === 'board' ? { board: true } : { comments: true }).finally(() => {
      if (state.running) schedule(kind, intervalOf(kind));
    });
  }, delaySeconds * 1000);
}

/** Starts the two timers — the board every `boardSeconds`, `@sloth` comments every `commentSeconds`. */
export function startLoop(): void {
  stopLoop();
  const c = cfg();
  if (!c.configured) return;
  state.running = true;
  log(`watching ${c.repo} · board #${c.project.number} · pickup "${c.statusField.columns.pickup.name}" · board ${c.boardSeconds}s / comments ${c.commentSeconds}s`);
  schedule('board', 5);
  schedule('comments', 20);
}

export function stopLoop(): void {
  if (state.running) log('watcher stopped');
  state.running = false;
  for (const key of ['board', 'comments'] as const) {
    clearTimeout(timers[key]);
    delete timers[key];
  }
  state.nextBoard = undefined;
  state.nextComment = undefined;
}

export const loopStatus = (): LoopStatus => ({ ...state });
