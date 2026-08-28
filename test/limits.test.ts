import { describe, expect, it } from 'vitest';
import { limitExit } from '../server/runner/limits';

describe('limitExit', () => {
  it('recognises the usage-limit phrasings on the exit path', () => {
    expect(limitExit('… working\nClaude AI usage limit reached|1234567')).toBe(true);
    expect(limitExit("You've hit your weekly limit")).toBe(true);
    expect(limitExit('You have reached your specified API usage limit')).toBe(true);
  });
  it('ignores a limit mentioned long before the end, or in a long report line', () => {
    const early = 'usage limit reached\n' + Array.from({ length: 6 }, (_, i) => `line ${i}`).join('\n');
    expect(limitExit(early)).toBe(false);
    expect(limitExit(`${'x'.repeat(300)} usage limit reached`)).toBe(false);
    expect(limitExit('The GitHub API rate limit is 5000 points per hour')).toBe(false);
  });
  it('is false for an empty or missing log', () => {
    expect(limitExit(undefined)).toBe(false);
    expect(limitExit('')).toBe(false);
  });
});
