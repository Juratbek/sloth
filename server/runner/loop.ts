import { cfg } from '../config';
import { broadcast } from '../events';
import { pruneBlocked } from './blocked';
import { fetchBoard } from './board';
import type { BoardItem } from './board';
import { setSnapshot } from './board-snapshot';
import { refreshColumns } from './columns';
import { comments } from './comments';
import { claimState, releaseState } from './owner';
import { mirrorComments } from './trello-mirror';
import { autoMerge, conflicts, failedChecks, finished } from './lifecycle';
import { isDry, log, nowSec, withDry } from './log';
import { boardEvents } from './notify-events';
import { sampleMachine } from './machine';
import { isPaused } from './pause';
import { pressure } from './pressure';
import { previews } from './preview';
import { qaSweep, qaVerdicts } from './qa';
import { smokeTick, smokeVerdicts } from './smoke';
import { prune } from './retention';
import { answered } from './answers';
import { pausedUntil, reap } from './run-control';
import { checkCopy } from './hours-copy';
import { handover, pickup, retryStranded, reviews } from './triggers';
import { healthTick } from '../health';
import { isWebhookLive, onWebhookChange } from '../webhook';
import { autoUpdate } from '../update';
import type { LoopStatus } from '../types';

export interface TickOptions {
  board?: boolean;
  comments?: boolean;
  dryRun?: boolean;
}

const state: LoopStatus = { running: false, ticking: false };
const timers: Partial<Record<Timed, NodeJS.Timeout>> = {};
/** How many times each timer has been armed; only the newest arming of a kind re-arms itself (`schedule`). */
const arms: Partial<Record<Timed, number>> = {};
let chain: Promise<unknown> = Promise.resolve();
/**
 * Which set of timers is the current one: a `schedule` re-arms only while its generation is still it.
 * Saving the settings mid-tick calls `startLoop` again, and the old set's tick would otherwise reach
 * its `.finally`, see `running` back at true and arm a second chain — the board polled twice for ever.
 */
let generation = 0;

/**
 * One reading of the machine, and what it means for the sessions already running. The tick and the
 * machine timer both come through here: the board is read every five minutes, and memory can be gone in
 * five seconds — `machineSeconds` is what makes the difference; the tick keeps its own reading so one
 * asked for by hand still sees the machine it is launching into.
 */
async function readMachine(): Promise<void> {
  const machine = await sampleMachine();
  if (machine.hold && machine.hold !== state.machine?.hold) log(`${machine.hold} — no new sessions until it clears`);
  else if (!machine.hold && state.machine?.hold) log('machine load cleared — new sessions may start');
  state.machine = machine;
  // A machine that stays over its limits with sessions running pauses the lowest-priority one.
  pressure();
}

/**
 * Runs `fn` between ticks — after the one in flight, before the next. The wizard saves through here: a
 * tick reads `cfg()` lazily at every step, so a config swapped out underneath one makes it straddle two —
 * the old board's item ids written with the new board's field ids, the snapshot refilled from a board gone.
 */
export function betweenTicks<T>(fn: () => T | Promise<T>): Promise<T> {
  const queued = chain.then(fn);
  // The chain must survive a failing `fn`, or every tick after it is rejected too.
  chain = queued.catch(() => undefined);
  return queued;
}

/**
 * Puts one mutation on the tick chain: it starts after the tick in flight has finished, and the next tick
 * waits for it. The monitor's stop-session, stop-preview, unblock and sweep-now buttons come through here.
 * They used to run the moment the request arrived — a stop racing the `reap` of a tick already in flight
 * over the same pid file and session state, two `previews` passes over one tunnel. Unlike `betweenTicks`
 * (the wizard's save, which wants the error back) a failure is logged and answered with `undefined`: a
 * button is not a place to unwind a tick from. `fn` must not itself call `tick`, which would wait for this.
 */
export function serial<T>(name: string, fn: () => T | Promise<T>): Promise<T | undefined> {
  const queued = chain.then(fn).catch((e) => {
    log(`${name} failed: ${(e instanceof Error ? e.message : String(e)).split('\n')[0]}`);
    return undefined;
  });
  chain = queued;
  return queued;
}

/** One pass. Ticks never overlap: every caller is queued behind the one in flight. */
export function tick(options: TickOptions = { board: true, comments: true }): Promise<void> {
  const queued = chain.then(() => runTick(options)).catch((e) => log(`tick failed: ${e}`));
  chain = queued;
  return queued;
}

/**
 * One step of a tick, on its own. A tick is a dozen independent errands, and a throw out of any of them
 * used to end the whole pass: one `gh` shape nobody expected in `reviews` and the cards in Code Review,
 * In Progress, QA and the pickup column were all left untouched for that tick — with `tick failed: …` the
 * only trace, naming the error and not the errand. Each step now fails on its own and the tick carries on
 * with the next; the ones that decide whether there is anything left to do at all (a usage-limit pause, a
 * user pause, a board that would not load) are still plain early returns above.
 */
async function step(name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    log(`step ${name} failed: ${(e instanceof Error ? e.message : String(e)).split('\n')[0]}`);
  }
}

/** A dry tick is dry for itself alone: the flag rides this call's async context, not the process (`log.ts`). */
const runTick = (options: TickOptions): Promise<void> => (options.dryRun ? withDry(() => tickSteps(options)) : tickSteps(options));

async function tickSteps({ board = false, comments: wantComments = false }: TickOptions): Promise<void> {
  state.ticking = true;
  try {
    await step('reap', reap);
    // Previews are finished work, not new work: they run even while paused.
    await step('previews', previews);
    // The hours ledger's copy on the assets branch: pushed when a run was booked, compared once an hour.
    await step('hours', checkCopy);
    await step('columns', refreshColumns);
    const paused = pausedUntil();
    if (nowSec() < paused) {
      log(`paused until ${new Date(paused * 1000).toISOString()} (usage limit)`);
      return;
    }
    // A user pause stops the launching triggers only: replies and deliveries are not new work.
    const userPaused = isPaused();
    if (userPaused) log('paused — no new work (reap, inbox delivery and status replies still run)');
    // Both kinds of tick may launch (an order does, from a comment): read the machine before either.
    else await step('machine', readMachine);
    if (wantComments) {
      state.lastComment = Date.now();
      // On a Trello board the card's comments come onto the issue first, so trigger 3 reads them like any other.
      await step('mirror', mirrorComments);
      await step('comments', comments);
    }
    if (!board) return;
    state.lastBoard = Date.now();
    // Housekeeping on work that is long over — it costs nothing and skips itself for an hour.
    await step('prune', prune);
    // Whether gh, git, the browser and sudo are still in order. Gated to ten minutes inside the step:
    // the board is read far more often than that, and "Tick now" more often again.
    await step('health', healthTick);
    let items: BoardItem[] | undefined;
    await step('board', async () => (items = await fetchBoard()));
    if (!items) return;
    // The home panel's board view mirrors this one read — a dry run reads the board too, and reading is harmless.
    setSnapshot(items);
    // Filing a closed issue away is bookkeeping on work that is already over, not new work — and so is
    // moving a card on the verdict its QA test left behind.
    await step('finished', () => finished(items!));
    await step('qa verdicts', qaVerdicts);
    await step('smoke verdicts', smokeVerdicts);
    // A blocked card a human has moved on is nobody's to hold back any more.
    await step('blocked', async () => pruneBlocked(items!));
    // The webhook hears about all of it even while paused: sessions keep running, so they keep parking.
    await step('board events', () => boardEvents(items!));
    if (userPaused) return;
    // The review first: a card in Code Review is finished work waiting on a short look, so it goes ahead
    // of everything that starts a build — a red check, a stranded card, an order, the pickup column.
    await step('reviews', () => reviews(items!));
    await step('failed checks', () => failedChecks(items!));
    // A conflict is the other way a finished PR stops being done; red checks go first, so a head with both
    // is sent back for the checks and the tick after sees whether the new head still conflicts.
    await step('conflicts', () => conflicts(items!));
    await step('handover', () => handover(items!));
    await step('auto-merge', () => autoMerge(items!));
    await step('retry stranded', () => retryStranded(items!));
    await step('answered', () => answered(items!));
    // The day's QA sweep, when it is time: the merged fixes waiting in QA are tested before new ones are started.
    await step('qa sweep', () => qaSweep(items!));
    // The smoke test when it is due: asked for at this hour, it goes ahead of the cards waiting for pickup.
    await step('smoke test', smokeTick);
    await step('pickup', () => pickup(items!));
  } finally {
    state.ticking = false;
    broadcast();
  }
}

type Timed = 'board' | 'comments' | 'machine' | 'update';
const TIMED: Timed[] = ['board', 'comments', 'machine', 'update'];

/**
 * How often mentions are looked for. With the GitHub webhook delivering them, the poll is only the net
 * under it and runs at `commentSeconds`; with nothing delivering — no public address, a tunnel that
 * moved, a token that may not write hooks — it is the only way a mention is read at all, and drops to
 * the shorter `fallbackCommentSeconds`.
 */
export const commentInterval = (): number => (isWebhookLive() ? cfg().commentSeconds : cfg().fallbackCommentSeconds);

const intervalOf = (kind: Timed) =>
  kind === 'board' ? cfg().boardSeconds : kind === 'comments' ? commentInterval() : kind === 'machine' ? cfg().machineSeconds : cfg().updateSeconds;

/** What one timer does when it fires. The machine's is its own pass, and never runs inside a tick. */
function fire(kind: Timed): Promise<unknown> {
  if (kind === 'board' || kind === 'comments') return tick(kind === 'board' ? { board: true } : { comments: true });
  if (kind === 'update') {
    // Sloth's own update goes on the tick chain: it waits for the tick in flight and holds the next one,
    // because the last step is a restart and a card half-moved through one is a card in two places.
    if (isDry()) return Promise.resolve();
    const queued = chain.then(() => autoUpdate()).catch((e) => log(`auto-update failed: ${e}`));
    chain = queued;
    return queued;
  }
  // A tick reads the machine itself; a user pause stops the reading with the launching it is for.
  if (state.ticking || isPaused() || isDry()) return Promise.resolve();
  return readMachine().catch((e) => log(`machine reading failed: ${e}`));
}

/**
 * Re-arms itself after every run, so a slow tick delays the next one instead of stacking up.
 *
 * `arms` counts the arming of each kind, and only the newest one of a kind ever re-arms. The generation
 * covers a whole set of timers being replaced (`startLoop`); this covers one of them being replaced on
 * its own by `rearm` — a run in flight when that happens holds a `.finally` that would otherwise arm a
 * second timer beside the fresh one, and two comment timers ticking for ever is two of every poll.
 */
function schedule(kind: Timed, delaySeconds: number, gen: number = generation): void {
  const seq = (arms[kind] = (arms[kind] ?? 0) + 1);
  const mine = () => state.running && gen === generation && arms[kind] === seq;
  const at = Date.now() + delaySeconds * 1000;
  if (kind === 'board') state.nextBoard = at;
  else if (kind === 'comments') state.nextComment = at;
  timers[kind] = setTimeout(() => {
    if (!mine()) return;
    void fire(kind).finally(() => {
      if (mine()) schedule(kind, intervalOf(kind), gen);
    });
  }, delaySeconds * 1000);
}

/**
 * Re-arms one timer against today's interval, dropping the wait already in flight. The webhook coming up
 * or going down changes which comment poll is in force, and waiting out an interval chosen under the old
 * answer is exactly the wrong way round: the fallback is wanted *because* deliveries have stopped.
 * The generation is left alone — this replaces one timer of the current set, it does not start a new set.
 */
export function rearm(kind: Timed): void {
  if (!state.running) return;
  clearTimeout(timers[kind]);
  schedule(kind, intervalOf(kind));
}

// Registered once, when the module loads: `webhook.ts` knows nothing about the loop, and the loop only
// asks it a question — the wiring between them is this line.
onWebhookChange(() => rearm('comments'));

/**
 * Starts the timers — the board every `boardSeconds`, `@sloth` comments every `commentSeconds`, the
 * machine every `machineSeconds`. The machine's is short on purpose: the holds and the pausing in
 * `pressure` can only act on a reading they have, and a reading every five minutes is one the kernel's
 * OOM killer beats to the punch. Sloth's own update gets a timer only when `autoUpdate` is on.
 */
export function startLoop(): void {
  stopLoop();
  const c = cfg();
  if (!c.configured) return;
  // The state directory is this instance's alone; on one another Sloth holds, nothing is scheduled at all.
  if (!claimState()) return;
  state.running = true;
  log(
    `watching ${c.repo} · ${c.project.provider === 'trello' ? `Trello board ${c.project.title}` : `board #${c.project.number}`} · pickup "${c.statusField.columns.pickup.name}" · board ${c.boardSeconds}s / comments ${c.commentSeconds}s (${c.fallbackCommentSeconds}s without the webhook) / machine ${c.machineSeconds}s${c.autoUpdate ? ` / auto-update ${c.updateSeconds}s` : ''}`,
  );
  schedule('board', 5);
  schedule('comments', 20);
  schedule('machine', c.machineSeconds);
  // A minute in, so a Sloth that was just started is watching before it thinks about replacing itself.
  if (c.autoUpdate) schedule('update', 60);
}

export function stopLoop(): void {
  releaseState();
  if (state.running) log('watcher stopped');
  state.running = false;
  // Whatever these timers had in flight belongs to the set being torn down; nothing of it re-arms.
  generation += 1;
  for (const key of TIMED) {
    clearTimeout(timers[key]);
    delete timers[key];
  }
  state.nextBoard = undefined;
  state.nextComment = undefined;
}

export const loopStatus = (): LoopStatus => ({ ...state });
