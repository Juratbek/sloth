import type { Rec } from './transcripts';

/** Anthropic API list prices, USD per million tokens. Cache reads, 5m writes and 1h writes are fixed multiples of input. */
interface Price {
  input: number;
  output: number;
}

/** First match wins, so the specific families sit above the broad `opus`/`sonnet`/`haiku` fallbacks. */
const PRICES: [RegExp, Price][] = [
  [/^claude-(fable|mythos)-5/, { input: 10, output: 50 }],
  [/^claude-opus-4-(1|20)/, { input: 15, output: 75 }], // Opus 4 / 4.1
  [/^claude-opus-/, { input: 5, output: 25 }], // Opus 4.5 → 5
  [/^claude-sonnet-5/, { input: 2, output: 10 }],
  [/^claude-sonnet-|^claude-3-7-sonnet/, { input: 3, output: 15 }],
  [/^claude-haiku-4/, { input: 1, output: 5 }],
  [/^claude-3-5-haiku/, { input: 0.8, output: 4 }],
];

const CACHE_READ = 0.1;
const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2;

export const priceOf = (model: string): Price | undefined => PRICES.find(([re]) => re.test(model))?.[1];

/**
 * What one API call would have cost at list price, or `undefined` for a model with no known price.
 * `u` is the raw `message.usage` of a transcript record. Claude Code writes 1h caches, so a record
 * without the `cache_creation` split is priced as all-1h rather than silently undercounted.
 */
export function costOf(model: string, u: Rec): number | undefined {
  const p = priceOf(model);
  if (!p) return undefined;
  const written: number = u.cache_creation_input_tokens ?? 0;
  const split = u.cache_creation;
  const w5m: number = split?.ephemeral_5m_input_tokens ?? 0;
  const w1h: number = split ? (split.ephemeral_1h_input_tokens ?? 0) : written;
  const inputCost =
    (u.input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0) * CACHE_READ +
    w5m * CACHE_WRITE_5M +
    w1h * CACHE_WRITE_1H;
  return (inputCost * p.input + (u.output_tokens ?? 0) * p.output) / 1e6;
}

/**
 * The same list price over a run's summed usage rather than one call's. Claude Code writes 1h caches
 * and a `ModelUsage` no longer knows the split, so every cache write is priced as one — the same
 * assumption `costOf` makes for a record without the split, and the one that cannot undercount.
 */
export function costOfUsage(model: string, u: { input: number; output: number; cacheRead: number; cacheWrite: number }): number | undefined {
  const p = priceOf(model);
  if (!p) return undefined;
  const input = u.input + u.cacheRead * CACHE_READ + u.cacheWrite * CACHE_WRITE_1H;
  return (input * p.input + u.output * p.output) / 1e6;
}
