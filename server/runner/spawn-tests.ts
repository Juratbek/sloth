import fs from 'node:fs';
import path from 'node:path';
import { cfg } from '../config';
import { label, repoRoot } from '../repos';
import type { IssueRef } from '../repo-types';
import { run } from './gh';
import { isDry, log, remove, write } from './log';
import { qaDir, qaRef, smokeDir, smokeRef, triesOn } from './session-dirs';
import { leaseSlot, releaseSlot } from './slots';
import { checkoutMissing, held, noSlot, start } from './spawn';
import { claimWarm } from './warm';

/**
 * The launches that test rather than build: the QA sweep's test of one card (trigger 9) and the scheduled
 * smoke test of the whole app (trigger 11). Both lease a worktree slot, pin the head they test, and hand a
 * warm stack on; neither claims a card or opens a PR. Split out of `spawn.ts`, which starts every run.
 */

/**
 * Trigger 9: the QA sweep's test of one card — `/sloth:qa <issue>` on `models.qa`, in a worktree of the QA
 * branch at `sha`, with the sweep's own budget. Held like an implement run, by the slots and the machine.
 * The run's directory is `qa-<issue>`, apart from the issue's implement run: the two may exist at once and
 * neither may touch the other's servers or worktree. The head under test is written beside the run, so the
 * verdict can be tied to it, and a run that ended without a verdict counts against `retries` — reset when
 * the branch moves on, since a new head is a new test.
 */
export async function launchQa(issue: IssueRef, sha: string, branch: string): Promise<boolean> {
  const c = cfg();
  const dir = qaDir(issue);
  const ref = qaRef(issue);
  const why = held() ?? checkoutMissing(issue.repo);
  if (why) {
    log(`QA ${label(issue)} queued (${why})`);
    return false;
  }
  const where = `${branch} @ ${sha.slice(0, 7)}`;
  if (isDry()) {
    log(`dry-run: would launch QA ${label(issue)} on ${c.models.qa} (${where})`);
    return true;
  }
  const slot = await leaseSlot(ref);
  if (!slot) return noSlot(`QA ${label(issue)}`);
  // Before the books are written: a test of a head the checkout has not fetched is a test of the wrong
  // code, and a run abandoned here must not count against the card's `retries` — see `launch`.
  const fetched = await run('git', ['-C', repoRoot(issue.repo), 'fetch', '-q', 'origin'], { timeout: 120_000 });
  if (!fetched.ok) {
    await releaseSlot(ref);
    log(`QA ${label(issue)} not launched: git fetch origin failed — ${fetched.err.split('\n')[0]}`);
    return false;
  }
  const retries = triesOn(dir, sha);
  for (const f of ['state.json', 'verdict', 'handled']) remove(path.join(dir, f));
  write(path.join(dir, 'sha'), sha);
  write(path.join(dir, 'retries'), String(retries + 1));
  // The head under test is known here, so a warm stack from an earlier test of this card on the same
  // head is reused untouched; the same stack on a moved branch still saves the boot, minus a reseed.
  const warm = await claimWarm(ref, slot, sha);
  log(`launch QA ${label(issue)} on ${c.models.qa} (${where})`);
  start(dir, dir, `/sloth:qa ${issue.number}`, { repo: issue.repo, issue: issue.number }, path.join(dir, 'run.log'), {
    model: c.models.qa,
    chrome: c.chrome,
    extras: { budgetMinutes: c.qa.budgetMinutes, worktree: slot, warm: !!warm, warmSame: warm?.same },
  });
  return true;
}

/**
 * Trigger 11: the scheduled smoke test — `/sloth:smoke <n>` on `models.smoke`, in a worktree of `branch` at
 * `sha` in `repo` (the smoke test's repository, `smoke.repo` — the first one when unset), with the smoke
 * test's own budget. Held like a QA run, by the slots and the machine. The run's directory is `smoke-<n>`,
 * `n` the run's own number (`smoke.ts`): it works for no card, so nothing on the board is touched and no
 * issue is told. The head under test, the branch and the brief from Settings go beside the run for the
 * session to read. No retries: a run that dies is over, and the next one runs when the schedule says.
 */
export async function launchSmoke(n: number, sha: string, branch: string, repo: string): Promise<boolean> {
  const c = cfg();
  const dir = smokeDir(n, repo);
  const ref = smokeRef(n, repo);
  const why = held() ?? checkoutMissing(repo);
  if (why) {
    log(`smoke test queued (${why})`);
    return false;
  }
  const where = `${branch} @ ${sha.slice(0, 7)}`;
  if (isDry()) {
    log(`dry-run: would launch smoke test ${n} on ${c.models.smoke} (${where})`);
    return true;
  }
  const slot = await leaseSlot(ref);
  if (!slot) return noSlot(`smoke test ${n}`);
  // A test of a head the checkout has not fetched is a test of the wrong code — see `launchQa`.
  const fetched = await run('git', ['-C', repoRoot(repo), 'fetch', '-q', 'origin'], { timeout: 120_000 });
  if (!fetched.ok) {
    await releaseSlot(ref);
    log(`smoke test ${n} not launched: git fetch origin failed — ${fetched.err.split('\n')[0]}`);
    return false;
  }
  fs.mkdirSync(dir, { recursive: true });
  write(path.join(dir, 'sha'), sha);
  write(path.join(dir, 'branch'), branch);
  if (c.smoke.brief) write(path.join(dir, 'brief.md'), `${c.smoke.brief}\n`);
  // Every run has a new number, so a warm stack is never "the same run": it is reused, minus a reseed.
  const warm = await claimWarm(ref, slot, sha);
  log(`launch smoke test ${n} on ${c.models.smoke} (${where})`);
  start(dir, dir, `/sloth:smoke ${n}`, { repo }, path.join(dir, 'run.log'), {
    model: c.models.smoke,
    chrome: c.chrome,
    extras: { budgetMinutes: c.smoke.budgetMinutes, worktree: slot, warm: !!warm, warmSame: warm?.same, smoke: { run: n, branch, sha } },
  });
  return true;
}
