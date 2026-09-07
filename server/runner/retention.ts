import fs from 'node:fs';
import path from 'node:path';
import { cfg } from '../config';
import { repoRoot, transcriptFile, untagName } from '../repos';
import { sameSlug } from '../repo-types';
import { forgetTranscript } from '../transcripts';
import { run } from './gh';
import { isDry, log, nowSec, readFile, readNumber, remove, write } from './log';
import { previewing, pruneCaches, trimRunLogs } from './caps';
import { statePath } from './markers';
import { dirAlive, dirOf, isBlocked, runDirs, stateOf, type Kind } from './session-dirs';
import { slotInUse, slotRepoConfigured } from './slots';
import { killWarm, warmOf } from './warm';

/**
 * Sloth never forgets on its own: every run leaves a session directory, a transcript and a handful of
 * markers behind, and a board that is worked every day fills `~/.sloth` with hundreds of them. This is
 * the sweep — anything finished longer than `keepDays` ago goes, and with a run its transcript under
 * `~/.claude/projects` (Claude Code writes it, but it is this run's and nobody else's). Worktrees are not
 * kept that long: a leftover per-issue one goes as soon as its run is over, and so does a pool slot the
 * pool no longer needs. A run that is alive, parked or still serving a preview is left alone however
 * old it looks. What a run leaves behind that outgrows the run itself — its build cache, its server
 * logs — is capped by `caps.ts` on the same sweep, whatever the run's age.
 */

const DAY = 24 * 3600;
const HOUR = 3600;
/** The watcher log is the UI's feed; past this it is rotated once, so one old copy is kept. */
const MAX_LOG = 5 << 20;

/** The newest mtime of these paths, in epoch seconds; 0 when none of them exists. */
const newest = (...paths: string[]): number =>
  paths.reduce((best, p) => {
    try {
      return Math.max(best, Math.floor(fs.statSync(p).mtimeMs / 1000));
    } catch {
      return best;
    }
  }, 0);


/** The transcript of the run booked in `dir` — its main `.jsonl` and the subagent files beside it, under the checkout of the run's repository. */
function removeTranscript(dir: string, repo?: string): void {
  const id = readFile(path.join(dir, 'session_id'))?.trim();
  if (!id || !/^[\w-]+$/.test(id)) return;
  const file = transcriptFile(id, repo);
  forgetTranscript(file);
  remove(file);
  remove(file.replace(/\.jsonl$/, ''));
}

function pruneSessions(cutoff: number): void {
  for (const { name, kind, target, repo, dir } of runDirs()) {
    // A live run, one whose app is still up behind a preview link, or one parked in needs-help waiting
    // for a human's answer, is not finished — the answer arrives whenever it arrives, and the reply
    // (trigger 6) reads the state, inbox and exits this directory holds. Parked is `waiting` in its
    // state: `blocked` marks only the run parked in place, with no needs-help column to move to.
    if (dirAlive(dir) || isBlocked(dir) || stateOf(dir).state === 'waiting' || (kind === 'issue' && previewing({ repo, number: target }))) continue;
    if (newest(dir, path.join(dir, 'state.json'), path.join(dir, 'run.log')) > cutoff) continue;
    if (isDry()) {
      log(`dry-run: would delete the session directory of ${name}`);
      continue;
    }
    removeTranscript(dir, repo);
    remove(dir);
    log(`pruned session ${name}`);
  }
}

/**
 * The worktrees nobody needs: a per-issue checkout of the old scheme whose run is over, a pool slot
 * numbered past `maxActive` that no run holds (the cap was lowered), and a slot's worktree of a repository
 * no longer configured. A slot within the pool stays — its installed dependencies are the next run's head
 * start. `git worktree remove` so git's own administrative files go too; each worktree is removed through
 * the checkout of its own repository (`repos.ts` `untagName` reads it off the name).
 *
 * A checkout git has already forgotten — its administrative files pruned, or the run that made it killed
 * before git finished — fails that command with "is not a working tree" for ever, and used to be logged
 * and left: the build output under it stayed on disk, and every sweep from then on spent a `git` call
 * failing the same way. Git having no record of it is exactly what makes the directory nobody's, so it
 * is deleted outright.
 */
async function pruneWorktrees(): Promise<void> {
  const c = cfg();
  let names: string[] = [];
  try {
    names = fs.readdirSync(c.worktreesDir);
  } catch {
    return;
  }
  const pruned = new Set<string>();
  for (const name of names) {
    // `issue-<n>` is an old implement run's checkout, `qa-<n>` the QA sweep's test of the same issue, `slot-<n>` the pool's —
    // each with `@owner~name` on the end in every repository but the legacy one.
    const { base, repo } = untagName(name);
    const m = /^(issue|qa|slot)-(\d+)$/.exec(base);
    const n = Number(m?.[2]);
    if (!m || !n) continue;
    const dir = path.join(c.worktreesDir, name);
    if (m[1] === 'slot') {
      if (n <= c.maxActive && slotRepoConfigured(name)) continue;
      if (slotInUse(base)) continue;
    } else if (dirAlive(dirOf({ kind: m[1] as Kind, target: n, repo })) || (m[1] === 'issue' && previewing({ repo, number: n }))) continue;
    if (isDry()) {
      log(`dry-run: would remove the worktree ${name}`);
      continue;
    }
    // A slot that leaves the pool takes its warm stack with it: servers, database, record (`warm.ts`). A slot that
    // stays, losing the worktree of a repository no longer configured, loses only a stack that was that repository's app.
    if (m[1] === 'slot' && n > c.maxActive) await killWarm(base, 'the slot leaves the pool');
    else if (m[1] === 'slot' && sameSlug(warmOf(base)?.repo ?? '', repo)) await killWarm(base, `${repo} is no longer one of Sloth's repositories`);
    const root = repoRoot(repo);
    pruned.add(root);
    const r = await run('git', ['-C', root, 'worktree', 'remove', dir, '--force'], { timeout: 120_000 });
    if (!r.ok && fs.existsSync(dir)) {
      const why = r.err.split('\n')[0];
      // Only when git disowns it: a removal that failed for any other reason (a lock, a busy file) is
      // left for the next sweep rather than deleted behind git's back.
      if (!/is not a working tree/i.test(why)) {
        log(`worktree ${name} could not be removed: ${why}`);
        continue;
      }
      remove(dir);
      log(`worktree ${name} deleted — git has no record of it (${why})`);
    }
    // The lease is the slot's, not one worktree's: it goes only with a slot that leaves the pool.
    if (m[1] === 'slot' && n > c.maxActive) remove(statePath('slots', base));
    log(`pruned worktree ${name}`);
  }
  for (const root of pruned) await run('git', ['-C', root, 'worktree', 'prune'], { timeout: 60_000 });
}

/** The dedupe markers that grow without bound: one per `@sloth` comment, one directory per status reply. */
function pruneMarkers(cutoff: number): void {
  for (const kind of ['status', 'seen']) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(statePath(kind));
    } catch {
      continue;
    }
    // A status reply books its pid in its own marker directory, so an old-looking one may still be running.
    const old = names.filter((name) => newest(statePath(kind, name)) <= cutoff && !(kind === 'status' && dirAlive(statePath(kind, name))));
    if (!old.length) continue;
    if (isDry()) {
      log(`dry-run: would prune ${old.length} ${kind} marker(s)`);
      continue;
    }
    for (const name of old) {
      // A status reply is a run of its own, booked in its marker directory: its transcript goes with it.
      if (kind === 'status') removeTranscript(statePath(kind, name));
      remove(statePath(kind, name));
    }
    log(`pruned ${old.length} ${kind} marker(s)`);
  }
}

function rotateLog(): void {
  const file = cfg().watcherLog;
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return;
  }
  if (size < MAX_LOG) return;
  const mb = Math.round(size / (1 << 20));
  if (isDry()) {
    log(`dry-run: would rotate the watcher log (${mb} MB)`);
    return;
  }
  fs.rmSync(`${file}.1`, { force: true });
  fs.renameSync(file, `${file}.1`);
  // The next line re-creates the file — the UI tails it, so it is never left missing for long.
  log(`rotated the watcher log at ${mb} MB (kept as ${path.basename(file)}.1)`);
}

/**
 * The sweep, at most once an hour — a board tick is every five minutes and nothing here changes that
 * fast. `state/pruned_at` carries the last one across a restart.
 */
export async function prune(): Promise<void> {
  const now = nowSec();
  if (now - readNumber(statePath('pruned_at')) < HOUR) return;
  if (!isDry()) write(statePath('pruned_at'), String(now));
  const cutoff = now - cfg().keepDays * DAY;
  pruneSessions(cutoff);
  await pruneWorktrees();
  pruneMarkers(cutoff);
  pruneCaches();
  trimRunLogs();
  rotateLog();
}
