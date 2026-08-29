import { describe, expect, it } from 'vitest';
import { versionOf } from '../server/update';

describe('versionOf', () => {
  it('takes major.minor from package.json and the patch from the merge count', () => {
    expect(versionOf('0.1.0', 19)).toBe('0.1.19');
    expect(versionOf('2.4.7', 0)).toBe('2.4.0');
  });

  it('falls back to package.json as it is when there is no count or no major.minor', () => {
    expect(versionOf('0.1.0', undefined)).toBe('0.1.0');
    expect(versionOf('', 19)).toBe('');
    expect(versionOf('3', 19)).toBe('3');
  });
});
