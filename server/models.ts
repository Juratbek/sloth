/**
 * The models Sloth can run an agent on, and where each one comes from.
 *
 * Claude Code only ever speaks the Anthropic API, so a model from someone else is reached by pointing
 * that same client at an Anthropic-compatible endpoint: `ANTHROPIC_BASE_URL` plus the provider's own key
 * in `ANTHROPIC_AUTH_TOKEN`. Nothing below is written for one vendor — a provider is a base URL, the
 * environment variable that holds its key, the models it serves and what they cost. Adding another is
 * adding a row.
 *
 * A provider is only offered in the model picker when its key is in the environment Sloth itself runs in
 * (`modelChoices`), and a session started on one of its models gets the routing environment
 * (`providerEnv`, spent in `runner/session-env.ts`). Anthropic needs neither: it is what the client does
 * unasked, so it has no key of its own here and the session inherits whatever credentials the machine
 * already logs Claude Code in with.
 */

/** List price in USD per million tokens, and how this model bills a cached prompt. */
export interface Price {
  input: number;
  output: number;
  /**
   * What a cache read and the two cache writes cost as a multiple of `input`. Absent takes the
   * provider's `cache`, which is what nearly every model of a provider uses.
   */
  cacheRead?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
}

/** How a provider bills cached prompts, as multiples of the input price. */
export interface CacheRates {
  read: number;
  write5m: number;
  write1h: number;
}

/** One entry in the model picker. `id` is what goes into `--model`: an alias Claude Code resolves, or a model id. */
export interface ModelOption {
  id: string;
  name: string;
  hint?: string;
}

export interface Provider {
  id: string;
  label: string;
  /** An Anthropic-compatible base URL, or empty for Anthropic itself — the client goes there on its own. */
  baseUrl: string;
  /** The environment variable holding this provider's key; empty means it needs none. Its presence is what "available" means. */
  tokenEnv: string;
  /** Where to get a key, shown against the models this machine's environment cannot reach. */
  docsUrl: string;
  /**
   * Environment the provider needs beyond the base URL and the key. Claude Code resolves the aliases a
   * plugin command may ask a subagent for (`opus`, `sonnet`, `haiku`) through these, so a routed session
   * has to map them onto models the provider actually serves — otherwise a subagent asks for a Claude
   * model on an endpoint that has never heard of one.
   */
  env: Record<string, string>;
  models: ModelOption[];
  cache: CacheRates;
  /** List prices for this provider's model ids as the transcripts report them; the first match wins. */
  prices: [RegExp, Price][];
}

/** Anthropic's cache multiples: a read is a tenth of input, a 5m write a quarter over it, a 1h write double. */
const ANTHROPIC_CACHE: CacheRates = { read: 0.1, write5m: 1.25, write1h: 2 };

export const PROVIDERS: Provider[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    baseUrl: '',
    tokenEnv: '',
    docsUrl: 'https://docs.claude.com/en/docs/claude-code',
    env: {},
    models: [
      { id: 'fable', name: 'Fable', hint: 'most capable' },
      { id: 'opus', name: 'Opus' },
      { id: 'sonnet', name: 'Sonnet' },
      { id: 'haiku', name: 'Haiku', hint: 'fastest and cheapest' },
    ],
    cache: ANTHROPIC_CACHE,
    // The specific families sit above the broad `opus` / `sonnet` / `haiku` fallbacks.
    prices: [
      [/^claude-(fable|mythos)-5/, { input: 10, output: 50 }],
      [/^claude-opus-4-(1|20)/, { input: 15, output: 75 }], // Opus 4 / 4.1
      [/^claude-opus-/, { input: 5, output: 25 }], // Opus 4.5 → 5
      [/^claude-sonnet-5/, { input: 2, output: 10 }],
      [/^claude-sonnet-|^claude-3-7-sonnet/, { input: 3, output: 15 }],
      [/^claude-haiku-4/, { input: 1, output: 5 }],
      [/^claude-3-5-haiku/, { input: 0.8, output: 4 }],
    ],
  },
  {
    id: 'zai',
    label: 'Z.ai',
    baseUrl: 'https://api.z.ai/api/anthropic',
    tokenEnv: 'SLOTH_ZAI_TOKEN',
    docsUrl: 'https://docs.z.ai/devpack/tool/claude',
    env: {
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.3',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.3-flash',
    },
    models: [
      { id: 'glm-5.3', name: 'GLM-5.3' },
      { id: 'glm-5.3-flash', name: 'GLM-5.3 Flash', hint: 'fastest and cheapest' },
    ],
    // Z.ai charges a cached prompt at its own rate and, for now, stores it for nothing: a write is
    // ordinary input, which is what a multiple of 1 says. `cacheRead` per model, the two rates differ.
    cache: { read: 0.2, write5m: 1, write1h: 1 },
    prices: [
      // $1.40 in / $4.40 out / $0.26 cached, and the Flash at $0.15 / $0.50 / $0.03.
      [/^glm-5\.3-flash/, { input: 0.15, output: 0.5, cacheRead: 0.03 / 0.15 }],
      [/^glm-5\.3/, { input: 1.4, output: 4.4, cacheRead: 0.26 / 1.4 }],
    ],
  },
];

/**
 * The provider a `--model` value belongs to, by the picker's own ids first and then by the price table —
 * so a model id pinned to a version (`glm-5.3-flash-…`) still routes. Undefined for anything unrecognised,
 * which leaves the session exactly as Claude Code would run it: a custom id keeps working.
 */
export function providerOf(model: string): Provider | undefined {
  const m = model.trim();
  if (!m) return undefined;
  return PROVIDERS.find((p) => p.models.some((o) => o.id === m)) ?? PROVIDERS.find((p) => p.prices.some(([re]) => re.test(m)));
}

/** Whether this machine's environment can reach the provider at all — Anthropic, needing no key of its own, always can. */
export const providerReady = (p: Provider, env: NodeJS.ProcessEnv): boolean => !p.tokenEnv || !!env[p.tokenEnv]?.trim();

/** One model as the picker shows it: what to save, who serves it, and whether this machine can reach them. */
export interface ModelChoice extends ModelOption {
  provider: string;
  providerLabel: string;
  /** False when the provider's key is missing here: the option is still listed, so it can be seen and asked for, but not picked. */
  available: boolean;
  /** The environment variable that would make it available — what to tell whoever wants it. */
  tokenEnv: string;
  docsUrl: string;
}

/** Every model Sloth knows, in provider order, judged against the environment Sloth itself is running in. */
export function modelChoices(env: NodeJS.ProcessEnv): ModelChoice[] {
  return PROVIDERS.flatMap((p) => {
    const available = providerReady(p, env);
    return p.models.map((m) => ({ ...m, provider: p.id, providerLabel: p.label, available, tokenEnv: p.tokenEnv, docsUrl: p.docsUrl }));
  });
}

/**
 * The routing environment a session running on `model` needs, empty for a model that is Anthropic's or
 * unrecognised. `ANTHROPIC_API_KEY` is cleared with it: an Anthropic key inherited from this process has
 * no business being sent to somebody else's endpoint, and `undefined` keeps a variable out of the child.
 */
export function providerEnv(model: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const p = providerOf(model);
  if (!p?.baseUrl || !providerReady(p, env)) return {};
  return {
    ...p.env,
    ANTHROPIC_BASE_URL: p.baseUrl,
    ANTHROPIC_AUTH_TOKEN: env[p.tokenEnv],
    ANTHROPIC_API_KEY: undefined,
  };
}
