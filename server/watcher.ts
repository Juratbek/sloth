import fs from 'node:fs';
import path from 'node:path';
import { cfg } from './config';
import { run } from './exec';
import { loopStatus } from './runner/loop';
import { readFile, readNumber } from './runner/log';
import { isPaused } from './runner/pause';
import { previewState } from './runner/preview';
import { pausedRun } from './runner/pressure';
import { sampleSessions } from './runner/session-load';
import { counter, isBlocked, pidAlive, pidOf, readState, runDirs } from './runner/session-dirs';
import type { Overview, RateBucket, WatcherSession } from './types';

/** The last `bytes` of a file, read from the end — a run log is megabytes, and the UI shows its tail. */
export function tailOf(f: string, bytes: number): string {
  try {
    const size = fs.statSync(f).size;
    const fd = fs.openSync(f, 'r');
    try {
      const buf = Buffer.alloc(Math.min(size, bytes));
      fs.readSync(fd, buf, 0, buf.length, size - buf.length);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

const mtime = (f: string) => {
  try {
    return fs.statSync(f).mtime;
  } catch {
    return undefined;
  }
};

/**
 * Every session directory as the monitor wants it. The directories themselves — which names count, what
 * kind and target each carries, what its `state.json` says — are `runner/session-dirs.ts`'s business;
 * this only adds what the UI needs on top. The two used to parse the same names and the same file
 * separately, and a kind added to one was a kind the other silently dropped.
 *
 * `alive` is the bare pid check on purpose, not `dirAlive`: the monitor shows a run whose pid file
 * predates the boot as it finds it, and it is the runner that decides such a run is somebody else's.
 */
export function listSessionDirs(): WatcherSession[] {
  const sessions = runDirs().map(({ name, kind, target, dir }): WatcherSession => {
    const pid = pidOf(dir);
    let inbox: string[] = [];
    try {
      inbox = fs.readdirSync(path.join(dir, 'inbox')).filter((f) => f.endsWith('.md'));
    } catch {
      /* no inbox */
    }
    const updated = [mtime(path.join(dir, 'state.json')), mtime(path.join(dir, 'run.log')), mtime(dir)]
      .filter((t): t is Date => !!t)
      .sort((a, b) => b.getTime() - a.getTime())[0];
    return {
      name,
      kind,
      target,
      pid,
      alive: pidAlive(pid),
      sessionId: readFile(path.join(dir, 'session_id'))?.trim() || undefined,
      state: readState(dir),
      preview: kind === 'issue' ? previewState(target) : undefined,
      retries: counter(dir, 'retries'),
      blocked: isBlocked(dir),
      paused: pausedRun(dir),
      issue: readNumber(path.join(dir, 'issue')) || undefined,
      runLogTail: tailOf(path.join(dir, 'run.log'), 4000),
      inbox,
      updatedAt: updated?.toISOString(),
    };
  });
  // One reading of the process table for all the live runs at once, then each takes its own tree's share.
  const loads = sampleSessions(sessions.filter((s) => s.alive).map((s) => s.pid!));
  for (const s of sessions) s.load = s.alive ? loads.get(s.pid!) : undefined;
  return sessions;
}

export function watcherInfo(): Overview['watcher'] {
  const lines = (readFile(cfg().watcherLog) ?? '').trimEnd().split('\n').filter(Boolean).slice(-150);
  const count = (d: string) => {
    try {
      return fs.readdirSync(path.join(cfg().stateDir, d)).length;
    } catch {
      return 0;
    }
  };
  return {
    logTail: lines,
    lastTick: mtime(cfg().watcherLog)?.toISOString(),
    paused: isPaused(),
    pausedUntil: readNumber(path.join(cfg().stateDir, 'paused_until')) || undefined,
    seen: count('seen'),
    reviewed: count('reviewed') + count('approved'),
    loop: loopStatus(),
  };
}

/** One `gh` read for the monitor's own sake — no retry: a figure the next poll asks for again. */
async function gh(args: string[]): Promise<string | undefined> {
  const r = await run('gh', args, { timeout: 15_000 });
  return r.ok ? r.out : undefined;
}

let rate: { at: number; value?: Record<string, RateBucket> } = { at: 0 };
export async function rateLimit() {
  if (Date.now() - rate.at < 60_000) return rate.value;
  rate = { at: Date.now() };
  const out = await gh(['api', 'rate_limit']);
  if (!out) return undefined;
  try {
    const r = JSON.parse(out).resources;
    rate.value = { core: r.core, graphql: r.graphql, search: r.search };
  } catch {
    /* unexpected shape */
  }
  return rate.value;
}

const titles = new Map<number, string>();
const pending = new Set<number>();
/** Issue / PR title, filled in asynchronously (REST, one call per number, ever). */
export function titleFor(n: number, coreRemaining: number | undefined): string | undefined {
  const t = titles.get(n);
  const repo = cfg().repo;
  if (!repo || t !== undefined || pending.has(n) || (coreRemaining ?? 0) < 200) return t;
  pending.add(n);
  void gh(['api', `repos/${repo}/issues/${n}`, '--jq', '.title'])
    .then((out) => {
      if (out) titles.set(n, out.trim());
    })
    // Fire and forget, but never unhandled: a rejection nobody catches ends the process, and with it the
    // watcher. The number simply stays untitled and the next poll asks again.
    .catch(() => undefined)
    .finally(() => pending.delete(n));
  return undefined;
}
