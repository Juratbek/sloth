import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { cfg } from './config';
import { loopStatus } from './runner/loop';
import type { Overview, RateBucket, WatcherSession, WatcherState } from './types';

const read = (f: string) => {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return undefined;
  }
};
const num = (f: string) => Number(read(f)?.trim() ?? 0) || 0;
const mtime = (f: string) => {
  try {
    return fs.statSync(f).mtime;
  } catch {
    return undefined;
  }
};
export function pidAlive(pid?: number) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function listSessionDirs(): WatcherSession[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(cfg().sessionsDir);
  } catch {
    return [];
  }
  return names.flatMap((name): WatcherSession[] => {
    const m = /^(issue|review)-(\d+)$/.exec(name);
    if (!m) return [];
    const d = path.join(cfg().sessionsDir, name);
    const pid = num(path.join(d, 'pid')) || undefined;
    let state: WatcherState | undefined;
    try {
      state = JSON.parse(read(path.join(d, 'state.json')) ?? '');
    } catch {
      /* no state yet */
    }
    let inbox: string[] = [];
    try {
      inbox = fs.readdirSync(path.join(d, 'inbox')).filter((f) => f.endsWith('.md'));
    } catch {
      /* no inbox */
    }
    const updated = [mtime(path.join(d, 'state.json')), mtime(path.join(d, 'run.log')), mtime(d)]
      .filter((t): t is Date => !!t)
      .sort((a, b) => b.getTime() - a.getTime())[0];
    return [
      {
        name,
        kind: m[1] as 'issue' | 'review',
        target: Number(m[2]),
        pid,
        alive: pidAlive(pid),
        sessionId: read(path.join(d, 'session_id'))?.trim() || undefined,
        state,
        retries: num(path.join(d, 'retries')),
        kills: num(path.join(d, 'kills')),
        blocked: fs.existsSync(path.join(d, 'blocked')),
        runLogTail: (read(path.join(d, 'run.log')) ?? '').slice(-4000),
        inbox,
        updatedAt: updated?.toISOString(),
      },
    ];
  });
}

export function watcherInfo(): Overview['watcher'] {
  const lines = (read(cfg().watcherLog) ?? '').trimEnd().split('\n').filter(Boolean).slice(-150);
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
    pausedUntil: num(path.join(cfg().stateDir, 'paused_until')) || undefined,
    seen: count('seen'),
    reviewed: count('reviewed'),
    loop: loopStatus(),
  };
}

function gh(args: string[]): Promise<string | undefined> {
  return new Promise((resolve) =>
    execFile('gh', args, { timeout: 15_000 }, (err, out) => resolve(err ? undefined : out)),
  );
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
  void gh(['api', `repos/${repo}/issues/${n}`, '--jq', '.title']).then((out) => {
    pending.delete(n);
    if (out) titles.set(n, out.trim());
  });
  return undefined;
}
