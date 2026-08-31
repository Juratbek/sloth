import fs from 'node:fs';
import path from 'node:path';
import { cfg } from '../config';
import { isDry, log, remove } from './log';
import { dirAlive, issueDir, runDirs } from './session-dirs';

/**
 * Two things a run leaves behind outgrow the runs themselves, and used to grow forever: the build cache
 * it fills under `.turbo/` — a busy board's runner root reached 1.7 GB in six days — and the logs of the
 * servers it boots, megabytes of query debug apiece. Both are capped here, whatever the run's age; the
 * hourly sweep in `retention.ts` calls both.
 */

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

/** A run whose app is still up behind a preview link is not finished. */
export const previewing = (issue: number) => fs.existsSync(path.join(issueDir(issue), 'preview-state.json'));

/** One file of a directory: what it costs and how recently it was written. */
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

/** One cache entry as turbo writes it — a tarball and its `-meta.json` — which are only any use together. */
interface CacheEntry {
  files: string[];
  size: number;
  at: number;
}

function cacheEntries(dir: string): CacheEntry[] {
  const byHash = new Map<string, CacheEntry>();
  for (const e of entriesOf(dir)) {
    const hash = path.basename(e.file).replace(/-meta\.json$|\.tar\.zst$/, '');
    const entry = byHash.get(hash) ?? { files: [], size: 0, at: 0 };
    entry.files.push(e.file);
    entry.size += e.size;
    entry.at = Math.max(entry.at, e.at);
    byHash.set(hash, entry);
  }
  return [...byHash.values()];
}

/**
 * Every build cache back under `MAX_CACHE`, oldest entry first — the runner root's and each worktree's.
 * Nothing pruned these before: `turbo` writes one tarball per task result and never evicts, so the
 * runner root of a board worked every day grew by a few hundred megabytes a day, indefinitely.
 */
export function pruneCaches(): void {
  const c = cfg();
  let roots: string[] = [c.runnerRoot];
  try {
    roots = [...roots, ...fs.readdirSync(c.worktreesDir).map((n) => path.join(c.worktreesDir, n))];
  } catch {
    /* no worktrees yet */
  }
  for (const root of roots) {
    for (const cache of CACHES) {
      const entries = cacheEntries(path.join(root, cache));
      let total = entries.reduce((n, e) => n + e.size, 0);
      if (total <= MAX_CACHE) continue;
      // Oldest first: the newest entries are the ones the next run is about to hit.
      const doomed: CacheEntry[] = [];
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
      for (const e of doomed) for (const file of e.files) remove(file);
      log(`pruned ${doomed.length} entr${doomed.length === 1 ? 'y' : 'ies'} (${mb} MB) from ${path.basename(root)}/${cache}`);
    }
  }
}

/**
 * The logs of the servers a finished run booted, cut back to their last `MAX_RUN_LOG` — a dev server
 * logging every query writes megabytes an hour, and until the run's whole directory is pruned that sits
 * on disk in full. The tail is kept because that is the end everything reads: the run's last words, the
 * error it died on. Only a run that is over is touched — a live one still has these files open, and a
 * writer that holds an offset would leave a hole rather than a shorter file. `run.log` is not a server
 * log and is left whole: its mtime is the run's age for `keepDays` and its place in the sidebar, and
 * `exits.ts` reads its run headers back from the start.
 */
export function trimRunLogs(): void {
  for (const { name, kind, target, dir } of runDirs()) {
    if (dirAlive(dir) || (kind === 'issue' && previewing(target))) continue;
    for (const file of entriesOf(dir)) {
      const base = path.basename(file.file);
      if (base === 'run.log' || !base.endsWith('.log') || file.size <= MAX_RUN_LOG) continue;
      const mb = Math.round((file.size - MAX_RUN_LOG) / (1 << 20));
      if (isDry()) {
        log(`dry-run: would trim ${base} of ${name} (${mb} MB)`);
        continue;
      }
      try {
        const fd = fs.openSync(file.file, 'r');
        const buf = Buffer.alloc(MAX_RUN_LOG);
        fs.readSync(fd, buf, 0, MAX_RUN_LOG, file.size - MAX_RUN_LOG);
        fs.closeSync(fd);
        // The cut is mid-line by definition; the marker says so, so nobody reads the first line as one.
        fs.writeFileSync(file.file, `… ${mb} MB trimmed by Sloth — the tail follows …\n${buf.toString('utf8')}`);
        log(`trimmed ${base} of ${name} by ${mb} MB`);
      } catch {
        /* gone, or unreadable: the whole directory goes at `keepDays` anyway */
      }
    }
  }
}
