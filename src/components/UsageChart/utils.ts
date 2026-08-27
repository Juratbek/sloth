import type { UsageBucket } from '../../../server/types';
import { usd } from '../../lib/format';

const MANTISSAS = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];

/** Smallest "nice" ceiling at or above `max`, so gridlines land on round numbers. */
export function niceMax(max: number) {
  if (max <= 0) return 1e6;
  const exp = 10 ** Math.floor(Math.log10(max));
  return (MANTISSAS.find((m) => m >= max / exp - 1e-9) ?? 10) * exp;
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
