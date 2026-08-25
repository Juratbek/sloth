import type { MonitorConfig, SessionKind, SessionStatus, SessionSummary, Usage } from '../../server/types';

export const k = (n: number) =>
  n < 1000 ? String(n) : n < 1e6 ? `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k` : `${(n / 1e6).toFixed(2)}M`;

export function duration(sec: number) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
}

export const clock = (iso?: string | number) =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';

export const ago = (iso?: string) => (iso ? duration((Date.now() - Date.parse(iso)) / 1000) : '—');

export function elapsed(s: { startedAt?: string; lastAt?: string; live: boolean }) {
  if (!s.startedAt) return '—';
  const end = s.live ? Date.now() : Date.parse(s.lastAt ?? s.startedAt);
  return duration((end - Date.parse(s.startedAt)) / 1000);
}

const KIND: Record<string, string> = { implement: 'fix', 'issue-status': 'status', other: 'run' };
export const label = (s: SessionSummary) => `${KIND[s.kind] ?? s.kind}${s.target ? ` #${s.target}` : ''}`;

export const STATUS_COLOR: Record<SessionStatus, string> = {
  running: 'bg-emerald-400',
  waiting: 'bg-amber-400',
  parked: 'bg-orange-500',
  done: 'bg-zinc-600',
};

/** Tokens the model saw on one call — the context window, not new spend. */
export const contextOf = (u: Usage) => u.input + u.cacheRead + u.cacheWrite;
/** Tokens actually sent fresh: uncached input plus what was written into the cache. */
export const newInput = (u: Usage) => u.input + u.cacheWrite;

export function nextTick(lastTick: string | undefined, tickSeconds: number) {
  if (!lastTick) return '—';
  const at = Date.parse(lastTick) + tickSeconds * 1000;
  return at < Date.now() ? 'due' : clock(at);
}

/** Link to the command's target on GitHub — the path segment comes from the configured command map. */
export const githubUrl = (kind: SessionKind, n: number | undefined, config: MonitorConfig) =>
  n && config.repo ? `https://github.com/${config.repo}/${config.commands[kind] ?? 'issues'}/${n}` : undefined;
