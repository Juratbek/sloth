import { cfg } from '../config';
import { broadcast } from '../events';
import { fetchBoard } from './board';
import { refreshColumns } from './columns';
import { comments } from './comments';
import { isDry, log, nowSec, setDry } from './log';
import { notifyParked } from './notify';
import { isPaused } from './pause';
import { answered } from './answers';
import { finalReviews, pausedUntil, pickup, reap, retryStranded, reviews } from './triggers';
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
    await refreshColumns();
    const paused = pausedUntil();
    if (nowSec() < paused) {
      log(`paused until ${new Date(paused * 1000).toISOString()} (usage limit)`);
      return;
    }
    // A user pause stops the launching triggers only: replies and deliveries are not new work.
    const userPaused = isPaused();
    if (userPaused) log('paused — no new work (reap, inbox delivery and status replies still run)');
    if (wantComments) {
      state.lastComment = Date.now();
      await comments();
    }
    if (!board) return;
    state.lastBoard = Date.now();
    const items = await fetchBoard();
    if (!items) return;
    // A parked card is announced even while paused: sessions keep running, so they keep parking.
    await notifyParked(items);
    if (userPaused) return;
    await reviews(items);
    await finalReviews(items);
    await retryStranded(items);
    await answered(items);
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
