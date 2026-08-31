import fs from 'node:fs';
import path from 'node:path';
import { cfg } from '../config';
import { forgetTranscript } from '../transcripts';
import { run } from './gh';
import { isDry, log, nowSec, readFile, readNumber, remove, write } from './log';
import { statePath } from './markers';
import { dirAlive, dirOf, issueDir, runDirs, type Kind } from './session-dirs';
import { slotInUse } from './slots';

/**
 * Sloth never forgets on its own: every run leaves a session directory, a transcript and a handful of
 * markers behind, and a board that is worked every day fills `~/.sloth` with hundreds of them. This is
 * the sweep — anything finished longer than `keepDays` ago goes, and with a run its transcript under
 * `~/.claude/projects` (Claude Code writes it, but it is this run's and nobody else's). Worktrees are not
 * kept that long: a leftover per-issue one goes as soon as its run is over, and so does a pool slot the
 * pool no longer needs. A run that is alive, parked or still serving a preview is left alone however
 * old it looks. Two things a run leaves behind outgrow the runs themselves, and used to grow forever:
 * the build cache it fills under `.turbo/` — a busy board's runner root reached 1.7 GB in six days —
 * and the logs of the servers it boots, megabytes of query debug apiece. Both are capped here.
 */

const DAY = 24 * 3600;
const HOUR = 3600;
/** The watcher log is the UI's feed; past this it is rotated once, so one old copy is kept. */
const MAX_LOG = 5 << 20;
/**
 * How much of one build cache is worth keeping. A cache is a speed feature, so this is a size cap and
 * not an age one: the newest entries — the ones the next run hits — stay, and the oldest go until the
 * directory is back under the cap.
 */
const MAX_CACHE = 512 << 20;
/** How much of one server log of a finished run is kept: the tail, which is the part that says how it ended. */
const MAX_RUN_LOG = 2 << 20;
/** The build caches a run fills, relative to the checkout it ran in. */
const CACHES = ['.turbo/cache'];

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

/** The transcript of the run booked in `dir` — its main `.jsonl` and the subagent files beside it. */
function removeTranscript(dir: string): void {
  const id = readFile(path.join(dir, 'session_id'))?.trim();
  if (!id || !/^[\w-]+$/.test(id)) return;
  forgetTranscript(path.join(cfg().transcriptsDir, `${id}.jsonl`));
  remove(path.join(cfg().transcriptsDir, `${id}.jsonl`));
  remove(path.join(cfg().transcriptsDir, id));
}

function pruneSessions(cutoff: number): void {
  for (const { name, kind, target, dir } of runDirs()) {
    // A live run, or one whose app is still up behind a preview link, is not finished.
    if (dirAlive(dir) || (kind === 'issue' && previewing(target))) continue;
    if (newest(dir, path.join(dir, 'state.json'), path.join(dir, 'run.log')) > cutoff) continue;
    if (isDry()) {
      log(`dry-run: would delete the session directory of ${name}`);
      continue;
    }
    removeTranscript(dir);
    remove(dir);
    log(`pruned session ${name}`);
  }
}

/**
 * The worktrees nobody needs: a per-issue checkout of the old scheme whose run is over, and a pool slot
 * numbered past `maxActive` that no run holds (the cap was lowered). A slot within the pool stays — its
 * installed dependencies are the next run's head start. `git worktree remove` so git's own administrative
 * files go too.
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
  let removed = 0;
  for (const name of names) {
    // `issue-<n>` is an old implement run's checkout, `qa-<n>` the QA sweep's test of the same issue, `slot-<n>` the pool's.
    const m = /^(issue|qa|slot)-(\d+)$/.exec(name);
    const n = Number(m?.[2]);
    if (!m || !n) continue;
    const dir = path.join(c.worktreesDir, name);
    if (m[1] === 'slot') {
      if (n <= c.maxActive || slotInUse(name)) continue;
    } else if (dirAlive(dirOf(m[1] as Kind, n)) || (m[1] === 'issue' && previewing(n))) continue;
    if (isDry()) {
      log(`dry-run: would remove the worktree ${name}`);
      continue;
    }
    const r = await run('git', ['-C', c.runnerRoot, 'worktree', 'remove', dir, '--force'], 120_000);
    if (!r.ok && fs.existsSync(dir)) {
      const why = r.err.split('\n')[0];
      // Only when git disowns it: a removal that failed for any other reason (a lock, a busy file) is
      // left for the next sweep rather than deleted behind git's back.
      if (!/is not a working tree|not a valid directory/i.test(why)) {
        log(`worktree ${name} could not be removed: ${why}`);
        continue;
      }
      remove(dir);
      log(`worktree ${name} deleted — git has no record of it (${why})`);
    }
    removed++;
    remove(statePath('slots', name));
    log(`pruned worktree ${name}`);
  }
  if (removed) await run('git', ['-C', c.runnerRoot, 'worktree', 'prune'], 60_000);
}

/** One file of a cache directory: what it costs and how recently it earned its place. */
interface Entry {
  file: string;
  size: number;
  at: number;
}

function entriesOf(dir: string): Entry[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const file = path.join(dir, name);
    try {
      const s = fs.statSync(file);
      return s.isFile() ? [{ file, size: s.size, at: s.mtimeMs }] : [];
    } catch {
      return [];
    }
  });
}

/**
 * Every build cache back under `MAX_CACHE`, oldest entry first — the runner root's and each worktree's.
 * Nothing pruned these before: `turbo` writes one tarball per task result and never evicts, so the
 * runner root of a board worked every day grew by a few hundred megabytes a day, indefinitely.
 */
function pruneCaches(): void {
  const c = cfg();
  let roots: string[] = [c.runnerRoot];
  try {
    roots = [...roots, ...fs.readdirSync(c.worktreesDir).map((n) => path.join(c.worktreesDir, n))];
  } catch {
    /* no worktrees yet */
  }
  for (const root of roots) {
    for (const cache of CACHES) {
      const dir = path.join(root, cache);
      const entries = entriesOf(dir);
      let total = entries.reduce((n, e) => n + e.size, 0);
      if (total <= MAX_CACHE) continue;
      // Oldest first: the newest entries are the ones the next run is about to hit.
      const doomed: Entry[] = [];
      for (const e of entries.sort((a, b) => a.at - b.at)) {
        if (total <= MAX_CACHE) break;
        doomed.push(e);
        total -= e.size;
      }
      const mb = Math.round(doomed.reduce((n, e) => n + e.size, 0) / (1 << 20));
      if (isDry()) {
        log(`dry-run: would free ${mb} MB from ${path.basename(root)}/${cache}`);
        continue;
      }
      for (const e of doomed) remove(e.file);
      log(`pruned ${doomed.length} entr${doomed.length === 1 ? 'y' : 'ies'} (${mb} MB) from ${path.basename(root)}/${cache}`);
    }
  }
}

/**
 * The logs of the servers a finished run booted, cut back to their last `MAX_RUN_LOG` — a dev server
 * logging every query writes megabytes an hour, and until the run's whole directory is pruned that sits
 * on disk in full. The tail is kept because that is the end everything reads: the run's last words, the
 * error it died on. Only a run that is over is touched — a live one still has these files open, and a
 * writer that holds an offset would leave a hole rather than a shorter file.
 */
function trimRunLogs(): void {
  for (const { name, kind, target, dir } of runDirs()) {
    if (dirAlive(dir) || (kind === 'issue' && previewing(target))) continue;
    for (const file of entriesOf(dir)) {
      if (!file.file.endsWith('.log') || file.size <= MAX_RUN_LOG) continue;
      const mb = Math.round((file.size - MAX_RUN_LOG) / (1 << 20));
      if (isDry()) {
        log(`dry-run: would trim ${path.basename(file.file)} of ${name} (${mb} MB)`);
        continue;
      }
      try {
        const fd = fs.openSync(file.file, 'r');
        const buf = Buffer.alloc(MAX_RUN_LOG);
        fs.readSync(fd, buf, 0, MAX_RUN_LOG, file.size - MAX_RUN_LOG);
        fs.closeSync(fd);
        // The cut is mid-line by definition; the marker says so, so nobody reads the first line as one.
        fs.writeFileSync(file.file, `… ${mb} MB trimmed by Sloth — the tail follows …\n${buf.toString('utf8')}`);
        log(`trimmed ${path.basename(file.file)} of ${name} by ${mb} MB`);
      } catch {
        /* gone, or unreadable: the whole directory goes at `keepDays` anyway */
      }
    }
  }
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
