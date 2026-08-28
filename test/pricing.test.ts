import { describe, expect, it } from 'vitest';
import { costOf, costOfUsage, priceOf } from '../server/pricing';

describe('priceOf', () => {
  it('knows the families and prefers the specific match', () => {
    expect(priceOf('claude-fable-5')).toEqual({ input: 10, output: 50 });
    expect(priceOf('claude-opus-4-1-20250805')).toEqual({ input: 15, output: 75 });
    expect(priceOf('claude-opus-5')).toEqual({ input: 5, output: 25 });
    expect(priceOf('claude-sonnet-5')).toEqual({ input: 2, output: 10 });
    expect(priceOf('claude-haiku-4-5-20251001')).toEqual({ input: 1, output: 5 });
    expect(priceOf('<synthetic>')).toBeUndefined();
  });
});

describe('costOf', () => {
  it('prices input, output, cache reads and both cache writes', () => {
    const usage = {
      input_tokens: 1_000_000,
      output_tokens: 100_000,
      cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 200_000,
      cache_creation: { ephemeral_5m_input_tokens: 100_000, ephemeral_1h_input_tokens: 100_000 },
    };
    // opus-5: (1M + 0.1M + 0.125M + 0.2M) * $5 + 0.1M * $25 = 7.125 + 2.5
    expect(costOf('claude-opus-5', usage)).toBeCloseTo(9.625, 6);
  });
  it('prices an unsplit cache write as 1h, never undercounting', () => {
    const c = costOf('claude-opus-5', { cache_creation_input_tokens: 1_000_000 });
    expect(c).toBeCloseTo(10, 6);
  });
  it('is undefined for a model with no list price', () => {
    expect(costOf('mystery', { input_tokens: 5 })).toBeUndefined();
  });
});

describe('costOfUsage', () => {
  it('prices a run’s summed usage, cache writes as 1h', () => {
    const usage = { input: 1_000_000, output: 100_000, cacheRead: 1_000_000, cacheWrite: 200_000 };
    // opus-5: (1M + 0.1M + 0.4M) * $5 + 0.1M * $25 = 7.5 + 2.5
    expect(costOfUsage('claude-opus-5', usage)).toBeCloseTo(10, 6);
    expect(costOfUsage('<synthetic>', usage)).toBeUndefined();
  });
});
