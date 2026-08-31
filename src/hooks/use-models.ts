import { useQuery } from '@tanstack/react-query';
import { PROVIDERS, type ModelChoice } from '../../server/models';
import { fetchJson } from '../lib/api';

/** Anthropic's models, which need no key of their own — what the picker offers before the server answers. */
const ALWAYS: ModelChoice[] = PROVIDERS.filter((p) => !p.tokenEnv).flatMap((p) =>
  p.models.map((m) => ({ ...m, provider: p.id, providerLabel: p.label, available: true, tokenEnv: p.tokenEnv, docsUrl: p.docsUrl })),
);

/**
 * Every model Sloth knows and whether this machine can reach the provider behind it. Only the machine
 * Sloth runs on may ask (the environment holds the keys), so a remote settings page falls back to the
 * models that need no key — it can still read what is configured and save it.
 */
export function useModels() {
  const query = useQuery({
    queryKey: ['models'],
    queryFn: () => fetchJson<ModelChoice[]>('/api/models'),
    retry: false,
    staleTime: 60_000,
  });
  return query.data ?? ALWAYS;
}
