import fs from 'node:fs';
import path from 'node:path';
import { cfg } from '../config';
import { label, primaryRepo, repoSlugs } from '../repos';
import type { IssueRef } from '../repo-types';
import { block, isCardBlocked } from './blocked';
import { moveCard } from './board';
import type { BoardItem } from './board';
import { forgetExits } from './exits';
import { gh } from './gh';
import { isDry, log, readFile, remove, write } from './log';
import { MARKERS, marker, skipped, statePath } from './markers';
import { notify } from './notify';
import { counter, dirAlive, issueDir, qaDir, runDirs } from './session-dirs';
import { launchQa } from './spawn-tests';

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
 * announced once, skipped by every sweep after, and waiting on a human to hand it back. With several
 * repositories the sweep pins the QA branch's head in each one; a repository without that branch has its
 * cards left alone, and the log says so.
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
  /** The head of the QA branch in each repository when the sweep opened; a repository without the branch is absent. */
  heads: Record<string, string>;
  /** Opened by the clock, so it counts as the day's sweep; a forced one from the monitor does not. */
  scheduled: boolean;
}

const sweepFile = () => statePath('qa_sweep');
export function openSweepState(): Sweep | undefined {
  try {
    const s = JSON.parse(readFile(sweepFile()) ?? '') as Sweep & { sha?: string };
    // A sweep an older Sloth opened pinned one head — the legacy repository's.
    return { ...s, heads: s.heads ?? (s.sha ? { [cfg().legacyRepo || primaryRepo()]: s.sha } : {}) };
  } catch {
    return undefined;
  }
}

/**
 * A branch — empty: the repository's default — and its current head, from GitHub: what every test of one
 * sweep checks out, and what a smoke test (`smoke.ts`) is pinned to. `what` names the caller in the log.
 */
export async function headOf(wanted: string, what: string, repo: string): Promise<{ branch: string; sha: string } | undefined> {
  let branch = wanted;
  if (!branch) {
    const r = await gh(['repo', 'view', repo, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name']);
    if (!r.ok || !r.out) {
      log(`${what}: the default branch of ${repo} could not be read: ${r.err.split('\n')[0]}`);
      return undefined;
    }
    branch = r.out;
  }
  const r = await gh(['api', `repos/${repo}/commits/${branch}`, '--jq', '.sha']);
  if (!r.ok || !/^[0-9a-f]{40}$/.test(r.out)) {
    log(`${what}: the head of ${branch} in ${repo} could not be read: ${r.err.split('\n')[0]}`);
    return undefined;
  }
  return { branch, sha: r.out };
}

/** The QA branch's head in every repository that has it. */
async function branchHeads(): Promise<{ branch: string; heads: Record<string, string> } | undefined> {
  const heads: Record<string, string> = {};
  let branch = cfg().qa.branch;
  for (const repo of repoSlugs()) {
    const head = await headOf(cfg().qa.branch, 'QA sweep', repo);
    if (!head) continue;
    heads[repo] = head.sha;
    branch ||= head.branch;
  }
  return Object.keys(heads).length ? { branch, heads } : undefined;
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
  const pinned = await branchHeads();
  if (!pinned) return undefined;
  const sweep: Sweep = { date: today, ...pinned, scheduled: !force };
  if (!isDry()) write(sweepFile(), JSON.stringify(sweep));
  log(`QA sweep opened${force ? ' from the monitor' : ''}: ${pinned.branch} @ ${Object.entries(pinned.heads).map(([repo, sha]) => `${repoSlugs().length > 1 ? `${repo} ` : ''}${sha.slice(0, 7)}`).join(', ')}`);
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
    const sha = sweep.heads[item.repo];
    if (!sha) {
      log(`QA ${label(item)} skipped: ${item.repo} has no ${sweep.branch} branch`);
      continue;
    }
    const tested = marker(MARKERS.qa, `${item.number}-${sha}`, item);
    if (fs.existsSync(tested) || isCardBlocked(item) || dirAlive(qaDir(item))) continue;
    // `reap` drops the marker of a run that died — or hung and was killed — without a verdict, so the card is tried again — this often, no more.
    if (counter(qaDir(item), 'retries') > c.maxRetries) {
      const head = sha.slice(0, 7);
      log(`QA ${label(item)} given up: its test ended without a verdict ${c.maxRetries + 1} times on ${head}`);
      if (!isDry()) write(tested, '');
      // Giving up used to end here, silently, with nothing to undo it short of the branch moving.
      await block(item, `its QA test ended without a verdict ${c.maxRetries + 1} times on ${sweep.branch} @ ${head}.`, sha);
      continue;
    }
    if (!(await launchQa(item, sha, sweep.branch))) return;
    if (!isDry()) write(tested, '');
  }
  if (!isDry()) {
    remove(sweepFile());
    if (sweep.scheduled) write(statePath('qa_ran'), sweep.date);
  }
  log(`QA sweep closed: ${cards.length} card(s) in ${col.name} tested on ${sweep.branch}`);
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
  for (const { kind, target, repo, dir } of runDirs()) {
    if (kind !== 'qa' || dirAlive(dir) || fs.existsSync(path.join(dir, 'handled'))) continue;
    const issue: IssueRef = { repo, number: target };
    const verdict = readFile(path.join(dir, 'verdict'))?.trim();
    if (!verdict) continue;
    const sha = (readFile(path.join(dir, 'sha')) ?? '').trim().slice(0, 7);
    const where = `${c.qa.branch || 'the default branch'}${sha ? ` @ ${sha}` : ''}`;
    if (verdict === 'passed') {
      const moved = col.done.id ? await moveCard(issue, col.done.id) : false;
      log(`QA ${label(issue)} passed on ${where} — ${moved ? `card to ${col.done.name}` : col.done.id ? 'the move failed, retried next tick' : 'no Done column, card stays'}`);
      if (col.done.id && !moved) continue;
      await notify('qaPassed', { issue, column: col.done.name, text: `${label(issue)} passed the QA sweep on ${where}` });
    } else if (verdict === 'failed') {
      if (!(await moveCard(issue, col.inProgress.id))) continue;
      // A stale handoff note goes with them: the new run works from the QA findings on the issue, not
      // from where a run long over thought it stopped.
      if (!isDry()) {
        for (const f of ['retries', 'blocked', 'handoff.md']) remove(path.join(issueDir(issue), f));
        // …and the ledger hears that the next run starts over (`launch` turns this into `started_fresh`).
        write(path.join(issueDir(issue), 'fresh'), '1');
        forgetExits(issueDir(issue));
      }
      log(`QA ${label(issue)} failed on ${where} — card to ${col.inProgress.name}, a new implement run reads the findings`);
      await notify('qaFailed', { issue, column: col.inProgress.name, text: `${label(issue)} failed the QA sweep on ${where} — back to ${col.inProgress.name}` });
    } else log(`QA ${label(issue)} ${verdict} on ${where} — card stays in ${col.qa.name}`);
    if (!isDry()) write(path.join(dir, 'handled'), '');
  }
}
