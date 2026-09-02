import { describe, expect, it } from 'vitest';
import { millions, niceMax } from '../src/components/UsageChart/utils';

describe('niceMax', () => {
  it('is a whole number of round steps, so every gridline label is a round number', () => {
    // 900k used to become 1.0M and then 0.3M / 0.7M / 1.0M — round ceiling, unround thirds.
    expect(niceMax(900_000, 3)).toBe(1_500_000);
    expect([1, 2, 3].map((i) => millions((1_500_000 * i) / 3))).toEqual(['0.5M', '1.0M', '1.5M']);
    expect(niceMax(2_400_000, 3)).toBe(3_000_000);
    expect(niceMax(100_000, 3)).toBe(150_000);
    expect(niceMax(3_000_000, 3)).toBe(3_000_000);
    expect(niceMax(12_000_000, 4)).toBe(20_000_000);
  });
  it('never sits below the peak, and gives an empty chart a scale of its own', () => {
    for (const max of [1, 7, 999_999, 1_000_001, 55_555_555]) expect(niceMax(max, 3)).toBeGreaterThanOrEqual(max);
    expect(niceMax(0)).toBe(1_000_000);
  });
});
