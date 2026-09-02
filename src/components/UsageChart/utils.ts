import type { UsageBucket } from '../../../server/types';
import { usd } from '../../lib/format';

const STEPS = [1, 2, 2.5, 5, 10];

/**
 * The chart's ceiling: `ticks` gridlines of one round step each, the smallest that clear `max`. The
 * ceiling used to be rounded on its own and then divided by the tick count, which left the labels
 * between the round numbers — a 900k peak read `0.3M / 0.7M / 1.0M`; now it reads `0.5M / 1.0M / 1.5M`.
 */
export function niceMax(max: number, ticks = 3) {
  if (max <= 0) return 1e6;
  const raw = max / ticks;
  const exp = 10 ** Math.floor(Math.log10(raw));
  return (STEPS.find((m) => m * exp >= raw - 1e-9) ?? 10) * exp * ticks;
}

export const millions = (n: number) => `${(n / 1e6).toFixed(n >= 1e7 || n === 0 ? 0 : 1)}M`;
export const totalOf = (b: UsageBucket) => b.cacheRead + b.newInput + b.output;

const hh = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:00`;

export function tooltip(b: UsageBucket) {
  const start = new Date(b.hour);
  const end = new Date(start.getTime() + 3_600_000);
  const day = start.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  return [
    `${day} ${hh(start)}–${hh(end)}`,
    `cache reads ${millions(b.cacheRead)} · new input ${millions(b.newInput)} · output ${millions(b.output)}`,
    `≈ ${usd(b.cost)} on API billing`,
  ].join('\n');
}

/** `Mon 25` — built by part so the weekday leads regardless of locale order. */
export function dayLabel(iso: string) {
  const d = new Date(iso);
  return `${d.toLocaleDateString([], { weekday: 'short' })} ${d.getDate()}`;
}

/** What the buckets cost on one local calendar day — `spentOn(buckets, new Date())` is today's spend. */
export const spentOn = (buckets: UsageBucket[], day: Date) => {
  const key = day.toDateString();
  return buckets.reduce((n, b) => (new Date(b.hour).toDateString() === key ? n + b.cost : n), 0);
};
