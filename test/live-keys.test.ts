import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { invalidateLive } from '../src/lib/live-keys';

/** The keys the app actually mounts, live ones and the expensive ones a live event must not touch. */
const KEYS = {
  overview: ['overview'],
  session: ['session', 'issue-4'],
  agent: ['session', 'issue-4', 'agent', 'tester'],
  usage: ['usage', 7],
  config: ['setup', 'config'],
  env: ['setup', 'env'],
  projects: ['setup', 'projects'],
  fields: ['setup', 'fields', 'PVT_1'],
  service: ['service'],
  remote: ['remote'],
  stack: ['stack', ''],
} as const;

/** A client holding one fresh cached entry per key, none of which would refetch on its own. */
function seeded(): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  for (const key of Object.values(KEYS)) client.setQueryData(key, 'cached');
  return client;
}

const staleOnes = (client: QueryClient) =>
  Object.entries(KEYS)
    .filter(([, key]) => client.getQueryState(key)?.isInvalidated)
    .map(([name]) => name)
    .sort();

describe('invalidateLive', () => {
  it('refetches only what a running session changes — a session, its agents, the overview and the usage', () => {
    const client = seeded();
    invalidateLive(client);
    expect(staleOnes(client)).toEqual(['agent', 'overview', 'session', 'usage']);
  });

  it('leaves the queries that shell out to gh and claude alone, however often events arrive', () => {
    const client = seeded();
    for (let i = 0; i < 50; i++) invalidateLive(client);
    for (const name of ['config', 'env', 'projects', 'fields', 'service', 'remote', 'stack'] as const) {
      expect(client.getQueryState(KEYS[name])?.isInvalidated).toBeFalsy();
    }
  });
});
