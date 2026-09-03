import type { MonitorConfig, SessionKind, SessionStatus, SessionSummary, Usage, WatcherSession } from '../../server/types';

export const k = (n: number) =>
  n < 1000 ? String(n) : n < 1e6 ? `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k` : `${(n / 1e6).toFixed(2)}M`;

/** Bytes as a monitor prints them — `640 kB`, `2.1 GB`. Binary steps, one decimal under ten. */
export function bytes(n: number) {
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i > 0 && n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

/** `$5,627.90` — always cents, so small hourly amounts still read as money. */
export const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export function duration(sec: number) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
}

/** Session-seconds as an invoice reads them: `12.5 h`, one decimal, never rounded to nothing while there is something. */
export const hrs = (sec: number) => `${(Math.round(Math.max(0, sec) / 360) / 10).toFixed(1)} h`;

export const clock = (iso?: string | number) =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';

/** Calendar day of a moment in local time, as "Today", "Yesterday", or a short date — for grouping lists by day. */
export function dayLabel(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(today) - startOf(d)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  const sameYear = d.getFullYear() === today.getFullYear();
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

export const ago = (iso?: string) => (iso ? duration((Date.now() - Date.parse(iso)) / 1000) : '—');
/** "until 14:05" for something that ends later today, "until Aug 29, 14:05" otherwise; "expiring" once it passed. */
export function untilLabel(epochSec: number): string {
  const at = new Date(epochSec * 1000);
  if (at.getTime() <= Date.now()) return 'expiring';
  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const sameDay = at.toDateString() === new Date().toDateString();
  return `until ${sameDay ? time : `${at.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`}`;
}

export function elapsed(s: { startedAt?: string; lastAt?: string; live: boolean }) {
  if (!s.startedAt) return '—';
  const end = s.live ? Date.now() : Date.parse(s.lastAt ?? s.startedAt);
  return duration((end - Date.parse(s.startedAt)) / 1000);
}

/**
 * A model id as a person says it: `claude-opus-4-1-20250805` → "opus 4.1", `claude-fable-5` → "fable 5",
 * `claude-3-5-haiku-20241022` → "haiku 3.5". An alias (`opus`, `fable`) or an id of another shape is shown as it is.
 */
export function modelName(id?: string): string | undefined {
  if (!id) return undefined;
  const m = /^claude-(?:(\d)-(?:(\d)-)?)?([a-z]+)(?:-(\d{1,2})(?:-(\d{1,2}))?)?(?:-\d{8})?$/.exec(id);
  if (!m) return id;
  const [, majorBefore, minorBefore, family, major, minor] = m;
  const version = [majorBefore ?? major, minorBefore ?? minor].filter(Boolean).join('.');
  return version ? `${family} ${version}` : family;
}

const KIND: Record<string, string> = { 'sloth:implement': 'fix', 'sloth:review': 'review', 'sloth:status': 'status', 'sloth:qa': 'QA', other: 'run' };
export const label = (s: SessionSummary) => `${KIND[s.kind] ?? s.kind}${s.target ? ` #${s.target}` : ''}`;

/** Step numbers are the section headings of the plugin commands; the UI shows what the session is doing instead. */
const IMPLEMENT_STEPS: Record<string, string> = {
  '0': 'claiming',
  '1': 'reading issue',
  '2': 'setting up',
  '3': 'implementing',
  '4': 'verifying',
  '4.5': 'browser testing',
  '5': 'opening PR',
  '5.5': 'in review',
  '6': 'handing off',
  '7': 'cleaning up',
  Q: 'asking',
};
const REVIEW_STEPS: Record<string, string> = {
  '1': 'resolving PR',
  '2': 'reading diff',
  '3': 'assessing',
  '4': 'commenting',
  '5': 'moving card',
  '5.5': 'labeling',
  '6': 'reporting',
};
const QA_STEPS: Record<string, string> = {
  '0': 'reading issue',
  '1': 'checking out',
  '2': 'booting app',
  '3': 'browser testing',
  '4': 'reporting',
  '5': 'cleaning up',
};
const STEPS: Record<WatcherSession['kind'], Record<string, string>> = { issue: IMPLEMENT_STEPS, review: REVIEW_STEPS, approved: REVIEW_STEPS, qa: QA_STEPS };
/** Human words for a session's current step; unknown values fall back to "step N" so nothing is hidden. */
export const stepLabel = (kind: WatcherSession['kind'], step?: string) =>
  step ? (STEPS[kind]?.[step.trim()] ?? `step ${step}`) : undefined;

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

/** A scheduled moment as a clock time, or "due" once it has passed. */
export const nextAt = (at?: number) => (!at ? '—' : at < Date.now() ? 'due' : clock(at));

/** Only http(s) URLs are safe as an href — a session writes `state.json`, so a `javascript:` value must not render. */
export const safeUrl = (u?: string) => (u && /^https?:\/\//i.test(u) ? u : undefined);

/** Link to the command's target on GitHub — the path segment comes from the configured command map. */
export const githubUrl = (kind: SessionKind, n: number | undefined, config: MonitorConfig) =>
  n && config.repo ? `https://github.com/${config.repo}/${config.commands[kind] ?? 'issues'}/${n}` : undefined;
