import fs from 'node:fs';
import path from 'node:path';
import { cfg } from '../config';
import { block, isCardBlocked } from './blocked';
import { moveCard } from './board';
import type { BoardItem } from './board';
import { forgetExits } from './exits';
import { gh } from './gh';
import { isDry, log, readFile, remove, write } from './log';
import { MARKERS, skipped, statePath } from './markers';
import { notify } from './notify';
import { counter, dirAlive, issueDir, qaDir, runDirs } from './session-dirs';
import { launchQa } from './spawn';

/**
 * Trigger 9 — the QA sweep. Once a day, at `qa.at` on this machine's clock, every card in the QA column
 * — a fix that is merged and deployed to `qa.branch`, waiting for a tester — gets a session of its own,
 * `/sloth:qa <issue>`, that checks the branch out at the head the sweep opened on, boots the app and
 * tests the fix as a user would. The session writes its verdict beside its run; the server turns it into
 * the move: `passed` → Done, `failed` → In Progress (where trigger 2 starts a fresh implement run that
 * reads the findings on the issue), `inconclusive` → the card stays. One test per card per head
 * (`state/qa/<issue>-<sha>`), so a card that passed is not tested again until the branch moves. A sweep
 * that cannot start every card at once (the caps, the machine) stays open across ticks until it has.
 * A card whose tests keep dying before they reach a verdict is given up on and blocked (`blocked.ts`):
 * announced once, skipped by every sweep after, and waiting on a human to hand it back.
 */

/** `YYYY-MM-DD` on this machine's clock — the sweep is a once-a-day thing in local time. */
export const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Whether the time of day `at` (`HH:MM`) has passed. */
export function pastTime(at: string, now = new Date()): boolean {
  const [h, m] = at.split(':').map(Number);
  return now.getHours() * 60 + now.getMinutes() >= h * 60 + m;
}

export interface Sweep {
  date: string;
  branch: string;
  sha: string;
  /** Opened by the clock, so it counts as the day's sweep; a forced one from the monitor does not. */
  scheduled: boolean;
}

const sweepFile = () => statePath('qa_sweep');
export function openSweepState(): Sweep | undefined {
  try {
    return JSON.parse(readFile(sweepFile()) ?? '') as Sweep;
  } catch {
    return undefined;
  }
}

/** The QA branch and its current head, from GitHub — what every test of one sweep checks out. */
async function branchHead(): Promise<{ branch: string; sha: string } | undefined> {
  const c = cfg();
  let branch = c.qa.branch;
  if (!branch) {
    const r = await gh(['repo', 'view', c.repo, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name']);
    if (!r.ok || !r.out) {
      log(`QA sweep: the default branch could not be read: ${r.err.split('\n')[0]}`);
      return undefined;
    }
    branch = r.out;
  }
  const r = await gh(['api', `repos/${c.repo}/commits/${branch}`, '--jq', '.sha']);
  if (!r.ok || !/^[0-9a-f]{40}$/.test(r.out)) {
    log(`QA sweep: the head of ${branch} could not be read: ${r.err.split('\n')[0]}`);
    return undefined;
  }
  return { branch, sha: r.out };
}

/**
 * The sweep in progress, or a new one when it is time: `qa.at` has passed and today's has not run — or
 * `force`, the monitor's button, which sweeps now whatever the clock says and leaves the day's own alone.
 */
export async function openSweep(force = false): Promise<Sweep | undefined> {
  const c = cfg();
  if (!c.statusField.columns.qa.id) {
    if (force) log('QA sweep: no QA column configured');
    return undefined;
  }
  const open = openSweepState();
  if (open) return open;
  const today = localDate();
  if (!force && (!c.qa.at || !pastTime(c.qa.at) || readFile(statePath('qa_ran'))?.trim() === today)) return undefined;
  const head = await branchHead();
  if (!head) return undefined;
  const sweep: Sweep = { date: today, ...head, scheduled: !force };
  if (!isDry()) write(sweepFile(), JSON.stringify(sweep));
  log(`QA sweep opened${force ? ' from the monitor' : ''}: ${head.branch} @ ${head.sha.slice(0, 7)}`);
  return sweep;
}

/** Starts a QA test for every card of the sweep that has not had one on this head; closes the sweep once all have. */
export async function qaSweep(board: BoardItem[]): Promise<void> {
  const c = cfg();
  const sweep = await openSweep();
  if (!sweep) return;
  const col = c.statusField.columns.qa;
  const cards = board.filter((i) => i.status === col.name && !i.closed && !skipped(i));
  for (const item of cards) {
    const issue = item.number;
    const marker = statePath(MARKERS.qa, `${issue}-${sweep.sha}`);
    if (fs.existsSync(marker) || isCardBlocked(issue) || dirAlive(qaDir(issue))) continue;
    // `reap` drops the marker of a run that died — or hung and was killed — without a verdict, so the card is tried again — this often, no more.
    if (counter(qaDir(issue), 'retries') > c.maxRetries) {
      const head = sweep.sha.slice(0, 7);
      log(`QA #${issue} given up: its test ended without a verdict ${c.maxRetries + 1} times on ${head}`);
      if (!isDry()) write(marker, '');
      // Giving up used to end here, silently, with nothing to undo it short of the branch moving.
      await block(item, `its QA test ended without a verdict ${c.maxRetries + 1} times on ${sweep.branch} @ ${head}.`, sweep.sha);
      continue;
    }
    if (!(await launchQa(issue, sweep.sha, sweep.branch))) return;
    if (!isDry()) write(marker, '');
  }
  if (!isDry()) {
    remove(sweepFile());
    if (sweep.scheduled) write(statePath('qa_ran'), sweep.date);
  }
  log(`QA sweep closed: ${cards.length} card(s) in ${col.name} tested on ${sweep.branch} @ ${sweep.sha.slice(0, 7)}`);
}

/**
 * The verdict a finished QA run wrote, turned into the board move it stands for — once per run
 * (`handled`). A run with no verdict is not this function's: it died, and `reap` gave its head back to
 * the sweep. A fail hands the card to a fresh implement run, so the count of a run long over must not
 * park the card instead: the issue's retries and exits are forgotten first.
 */
export async function qaVerdicts(): Promise<void> {
  const c = cfg();
  const col = c.statusField.columns;
  for (const { kind, target: issue, dir } of runDirs()) {
    if (kind !== 'qa' || dirAlive(dir) || fs.existsSync(path.join(dir, 'handled'))) continue;
    const verdict = readFile(path.join(dir, 'verdict'))?.trim();
    if (!verdict) continue;
    const sha = (readFile(path.join(dir, 'sha')) ?? '').trim().slice(0, 7);
    const where = `${c.qa.branch || 'the default branch'}${sha ? ` @ ${sha}` : ''}`;
    if (verdict === 'passed') {
      const moved = col.done.id ? await moveCard(issue, col.done.id) : false;
      log(`QA #${issue} passed on ${where} — ${moved ? `card to ${col.done.name}` : col.done.id ? 'the move failed, retried next tick' : 'no Done column, card stays'}`);
      if (col.done.id && !moved) continue;
      await notify('qaPassed', { issue, column: col.done.name, text: `#${issue} passed the QA sweep on ${where}` });
    } else if (verdict === 'failed') {
      if (!(await moveCard(issue, col.inProgress.id))) continue;
      for (const f of ['retries', 'blocked']) remove(path.join(issueDir(issue), f));
      forgetExits(issueDir(issue));
      log(`QA #${issue} failed on ${where} — card to ${col.inProgress.name}, a new implement run reads the findings`);
      await notify('qaFailed', { issue, column: col.inProgress.name, text: `#${issue} failed the QA sweep on ${where} — back to ${col.inProgress.name}` });
    } else log(`QA #${issue} ${verdict} on ${where} — card stays in ${col.qa.name}`);
    if (!isDry()) write(path.join(dir, 'handled'), '');
  }
}
