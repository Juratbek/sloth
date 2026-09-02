import { listPrice, type Price } from './models';
import type { Rec } from './transcripts';

/**
 * What a run would have cost at list price. The prices themselves live with the providers that charge
 * them (`models.ts`); this file is only the arithmetic, so a new provider needs nothing here.
 */

/** A model's price together with the cache multiples that apply to it — its own read rate, its provider's writes. */
function rated(model: string): { price: Price; read: number; write5m: number; write1h: number } | undefined {
  const hit = listPrice(model);
  if (!hit) return undefined;
  const { provider, price } = hit;
  return { price, read: price.cacheRead ?? provider.cache.read, write5m: provider.cache.write5m, write1h: provider.cache.write1h };
}

export const priceOf = (model: string): Price | undefined => rated(model)?.price;

/**
 * What one API call would have cost at list price, or `undefined` for a model with no known price.
 * `u` is the raw `message.usage` of a transcript record. Claude Code writes 1h caches, so a record
 * without the `cache_creation` split is priced as all-1h rather than silently undercounted.
 */
export function costOf(model: string, u: Rec): number | undefined {
  const r = rated(model);
  if (!r) return undefined;
  const written: number = u.cache_creation_input_tokens ?? 0;
  const split = u.cache_creation;
  const w5m: number = split?.ephemeral_5m_input_tokens ?? 0;
  const w1h: number = split ? (split.ephemeral_1h_input_tokens ?? 0) : written;
  const inputCost =
    (u.input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0) * r.read +
    w5m * r.write5m +
    w1h * r.write1h;
  return (inputCost * r.price.input + (u.output_tokens ?? 0) * r.price.output) / 1e6;
}

/**
 * The same list price over a run's summed usage rather than one call's. Claude Code writes 1h caches
 * and a `ModelUsage` no longer knows the split, so every cache write is priced as one — the same
 * assumption `costOf` makes for a record without the split, and the one that cannot undercount.
 */
export function costOfUsage(model: string, u: { input: number; output: number; cacheRead: number; cacheWrite: number }): number | undefined {
  const r = rated(model);
  if (!r) return undefined;
  const input = u.input + u.cacheRead * r.read + u.cacheWrite * r.write1h;
  return (input * r.price.input + u.output * r.price.output) / 1e6;
}
