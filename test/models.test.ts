import { afterEach, describe, expect, it } from 'vitest';
import { modelChoices, providerEnv, providerOf } from '../server/models';
import { costOf, priceOf } from '../server/pricing';
import { sessionEnv } from '../server/runner/session-env';
import { configure, root } from './harness';

const withKey = { SLOTH_ZAI_TOKEN: 'zai-key' } as NodeJS.ProcessEnv;
const withoutKey = {} as NodeJS.ProcessEnv;

describe('providerOf', () => {
  it('finds a provider by the id the picker offers', () => {
    expect(providerOf('opus')?.id).toBe('anthropic');
    expect(providerOf('glm-5.3-flash')?.id).toBe('zai');
  });
  it('finds one by the price table too, so a versioned id still routes', () => {
    expect(providerOf('claude-opus-5')?.id).toBe('anthropic');
    expect(providerOf('glm-5.3-flash-20260827')?.id).toBe('zai');
  });
  it('claims nothing it does not know, leaving a custom model as Claude Code would run it', () => {
    expect(providerOf('some-local-model')).toBeUndefined();
    expect(providerOf('')).toBeUndefined();
  });
});

describe('providerEnv', () => {
  it('points Claude Code at the provider and hands it the key', () => {
    const env = providerEnv('glm-5.3', withKey);
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.z.ai/api/anthropic');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('zai-key');
  });
  it('maps the aliases a subagent may ask for onto models the provider serves', () => {
    const env = providerEnv('glm-5.3', withKey);
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('glm-5.3');
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('glm-5.3-flash');
  });
  it('never lets an inherited Anthropic key reach somebody else’s endpoint', () => {
    expect('ANTHROPIC_API_KEY' in providerEnv('glm-5.3', withKey)).toBe(true);
    expect(providerEnv('glm-5.3', withKey).ANTHROPIC_API_KEY).toBeUndefined();
  });
  it('routes nothing for Anthropic’s own models, which need no routing', () => {
    expect(providerEnv('opus', withKey)).toEqual({});
    expect(providerEnv('claude-opus-5', withKey)).toEqual({});
  });
  it('routes nothing for a provider whose key this machine does not have', () => {
    expect(providerEnv('glm-5.3', withoutKey)).toEqual({});
  });
  it('routes nothing for a model it does not know', () => {
    expect(providerEnv('some-local-model', withKey)).toEqual({});
  });
});

describe('modelChoices', () => {
  it('offers every model and marks the ones this environment can reach', () => {
    const on = modelChoices(withKey);
    expect(on.find((c) => c.id === 'opus')?.available).toBe(true);
    expect(on.find((c) => c.id === 'glm-5.3-flash')?.available).toBe(true);
  });
  it('still lists a provider without its key, naming the variable that would turn it on', () => {
    const off = modelChoices(withoutKey);
    const glm = off.find((c) => c.id === 'glm-5.3');
    expect(glm?.available).toBe(false);
    expect(glm?.tokenEnv).toBe('SLOTH_ZAI_TOKEN');
    // Anthropic has no key of its own here: the machine's Claude Code login is what it uses.
    expect(off.find((c) => c.id === 'opus')?.available).toBe(true);
  });
});

describe('pricing a provider’s models', () => {
  it('knows what the provider charges', () => {
    expect(priceOf('glm-5.3')).toMatchObject({ input: 1.4, output: 4.4 });
    expect(priceOf('glm-5.3-flash')).toMatchObject({ input: 0.15, output: 0.5 });
  });
  it('prefers the Flash entry over the family it sits inside', () => {
    expect(priceOf('glm-5.3-flash')?.input).toBe(0.15);
  });
  it('bills a cached prompt at the provider’s own rate, not Anthropic’s', () => {
    // glm-5.3-flash: 1M cached reads at $0.03/M, and a cache write is ordinary input at $0.15/M.
    expect(costOf('glm-5.3-flash', { cache_read_input_tokens: 1_000_000 })).toBeCloseTo(0.03, 6);
    expect(costOf('glm-5.3-flash', { cache_creation_input_tokens: 1_000_000 })).toBeCloseTo(0.15, 6);
  });
});

describe('a session started on another provider', () => {
  const set = (v?: string) => (v === undefined ? delete process.env.SLOTH_ZAI_TOKEN : (process.env.SLOTH_ZAI_TOKEN = v));
  afterEach(() => set(undefined));

  it('is pointed at the provider, and an Anthropic one is left alone', () => {
    configure();
    set('zai-key');
    const glm = sessionEnv(root(), { issue: 1 }, 'glm-5.3-flash', false);
    expect(glm.ANTHROPIC_BASE_URL).toBe('https://api.z.ai/api/anthropic');
    expect(glm.ANTHROPIC_AUTH_TOKEN).toBe('zai-key');
    expect(glm.SLOTH_MODEL).toBe('glm-5.3-flash');
    // The rest of the environment a session lives on is untouched by the routing.
    expect(glm.SLOTH_ISSUE).toBe('1');
    expect(sessionEnv(root(), { issue: 1 }, 'opus', false).ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it('is not pointed anywhere without the provider’s key — it runs as it always did', () => {
    configure();
    expect(sessionEnv(root(), { issue: 1 }, 'glm-5.3-flash', false).ANTHROPIC_BASE_URL).toBeUndefined();
  });
});
