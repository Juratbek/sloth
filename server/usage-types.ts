/** The spend series the usage chart draws — hourly buckets and the per-model dollars behind them.
 *  Split out of `types.ts`, which re-exports it. */

export interface UsageBucket {
  hour: string;
  newInput: number;
  cacheRead: number;
  output: number;
  /** USD at API list price for the priced models in this hour. */
  cost: number;
}
/** `cost` is null for a model with no known list price — its tokens still count, its dollars don't. */
export interface ModelCost {
  model: string;
  cost: number | null;
}
export interface UsageSeries {
  from: string;
  to: string;
  buckets: UsageBucket[];
  /** What the whole window would have cost on API billing, summed over `byModel`. */
  cost: number;
  byModel: ModelCost[];
}
