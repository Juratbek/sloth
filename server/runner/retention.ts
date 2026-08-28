import fs from 'node:fs';
import path from 'node:path';
import { cfg } from '../config';
import { run } from './gh';
import { isDry, log, nowSec, readNumber, remove, write } from './log';
import { statePath } from './markers';
import { issueDir, dirAlive, issueAlive, runDirs } from './session-dirs';

/**
 * Sloth never forgets on its own: every run leaves a session directory, a worktree and a handful of
 * markers behind, and a board that is worked every day fills `~/.sloth` with hundreds of them. This is
 * the sweep — anything finished longer than `keepDays` ago goes. Only what Sloth wrote is deleted:
 * transcripts live under `~/.claude` and belong to Claude Code, and a run that is alive, parked or
 * still serving a preview is left alone however old it looks.
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

const previewing = (issue: number) => fs.existsSync(path.join(issueDir(issue), 'preview-state.json'));

function pruneSessions(cutoff: number): void {
  for (const { name, kind, target, dir } of runDirs()) {
    // A live run, or one whose app is still up behind a preview link, is not finished.
    if (dirAlive(dir) || (kind === 'issue' && previewing(target))) continue;
    if (newest(dir, path.join(dir, 'state.json'), path.join(dir, 'run.log')) > cutoff) continue;
    if (isDry()) {
      log(`dry-run: would delete the session directory of ${name}`);
      continue;
    }
    remove(dir);
    log(`pruned session ${name}`);
  }
}

/** The checkouts of runs long over. `git worktree remove` so git's own administrative files go too. */
async function pruneWorktrees(cutoff: number): Promise<void> {
  const c = cfg();
  let names: string[] = [];
  try {
    names = fs.readdirSync(c.worktreesDir);
  } catch {
    return;
  }
  let removed = 0;
  for (const name of names) {
    const issue = Number(/^issue-(\d+)$/.exec(name)?.[1]);
    if (!issue) continue;
    const dir = path.join(c.worktreesDir, name);
    if (issueAlive(issue) || previewing(issue) || newest(dir) > cutoff) continue;
    if (isDry()) {
      log(`dry-run: would remove the worktree of #${issue}`);
      continue;
    }
    const r = await run('git', ['-C', c.runnerRoot, 'worktree', 'remove', dir, '--force'], 120_000);
    if (!r.ok && fs.existsSync(dir)) {
      log(`worktree ${name} could not be removed: ${r.err.split('\n')[0]}`);
      continue;
    }
    removed++;
    log(`pruned worktree ${name}`);
  }
  if (removed) await run('git', ['-C', c.runnerRoot, 'worktree', 'prune'], 60_000);
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
    const old = names.filter((name) => newest(statePath(kind, name)) <= cutoff);
    if (!old.length) continue;
    if (isDry()) {
      log(`dry-run: would prune ${old.length} ${kind} marker(s)`);
      continue;
    }
    for (const name of old) remove(statePath(kind, name));
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
  await pruneWorktrees(cutoff);
  pruneMarkers(cutoff);
  rotateLog();
}
