import { describe, expect, it } from 'vitest';
import { modelName } from '../src/lib/format';

describe('modelName', () => {
  it('says a model id the way a person does', () => {
    expect(modelName('claude-opus-4-1-20250805')).toBe('opus 4.1');
    expect(modelName('claude-sonnet-4-5-20250929')).toBe('sonnet 4.5');
    expect(modelName('claude-haiku-4-5-20251001')).toBe('haiku 4.5');
    expect(modelName('claude-opus-4-20250514')).toBe('opus 4');
    expect(modelName('claude-fable-5')).toBe('fable 5');
    expect(modelName('claude-3-5-haiku-20241022')).toBe('haiku 3.5');
    expect(modelName('claude-3-7-sonnet-20250219')).toBe('sonnet 3.7');
  });
  it('leaves an alias or a foreign id alone, and nothing as nothing', () => {
    expect(modelName('opus')).toBe('opus');
    expect(modelName('us.anthropic.claude-opus-5')).toBe('us.anthropic.claude-opus-5');
    expect(modelName(undefined)).toBeUndefined();
  });
});
