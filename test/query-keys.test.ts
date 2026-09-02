import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { queryKeys } from '../src/lib/query-keys';

/** Every key the app mounts, under the name the hook that mounts it goes by. */
const MOUNTED = {
  overview: queryKeys.overview,
  session: queryKeys.session('issue-4'),
  otherSession: queryKeys.session('review-9'),
  agent: queryKeys.agent('issue-4', 'tester'),
  usage: queryKeys.usage(7),
  otherUsage: queryKeys.usage(31),
  models: queryKeys.models,
  health: queryKeys.health,
  remote: queryKeys.remote,
  stack: queryKeys.stack(),
  stackAt: queryKeys.stack('/src/medora'),
  update: queryKeys.update,
  service: queryKeys.service,
  config: queryKeys.setupConfig,
  env: queryKeys.setupEnv,
  projects: queryKeys.setupProjects,
  fields: queryKeys.setupFields('PVT_1'),
};

/** A client holding one fresh entry per mounted key, none of which would refetch on its own. */
function seeded(): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  for (const key of Object.values(MOUNTED)) client.setQueryData(key, 'cached');
  return client;
}

/** The names of the mounted queries one invalidation reached. */
function reachedBy(queryKey: readonly unknown[]): string[] {
  const client = seeded();
  void client.invalidateQueries({ queryKey });
  return Object.entries(MOUNTED)
    .filter(([, key]) => client.getQueryState(key)?.isInvalidated)
    .map(([name]) => name)
    .sort();
}

describe('queryKeys', () => {
  it('gives every query a key of its own', () => {
    const written = Object.values(MOUNTED).map((k) => JSON.stringify(k));
    expect(new Set(written).size).toBe(written.length);
  });

  it('nests a session and its subagents under the sessions prefix', () => {
    expect(reachedBy(queryKeys.sessions)).toEqual(['agent', 'otherSession', 'session']);
    expect(reachedBy(queryKeys.session('issue-4'))).toEqual(['agent', 'session']);
    expect(reachedBy(queryKeys.agent('issue-4', 'tester'))).toEqual(['agent']);
  });

  it('nests every window of the usage series under one prefix', () => {
    expect(reachedBy(queryKeys.allUsage)).toEqual(['otherUsage', 'usage']);
    expect(reachedBy(queryKeys.usage(7))).toEqual(['usage']);
  });

  it('nests every checkout the stack is judged against under one prefix', () => {
    expect(reachedBy(queryKeys.allStack)).toEqual(['stack', 'stackAt']);
    expect(reachedBy(queryKeys.stack())).toEqual(['stack']);
  });

  it('nests everything the wizard asks the server under the setup prefix', () => {
    expect(reachedBy(queryKeys.setup)).toEqual(['config', 'env', 'fields', 'projects']);
  });

  it('keeps the standalone keys standalone — one invalidation, one query', () => {
    for (const [name, key] of [
      ['overview', queryKeys.overview],
      ['models', queryKeys.models],
      ['health', queryKeys.health],
      ['remote', queryKeys.remote],
      ['update', queryKeys.update],
      ['service', queryKeys.service],
    ] as const) {
      expect(reachedBy(key)).toEqual([name]);
    }
  });

  it('never lets a live key reach one that shells out to gh or claude', () => {
    const expensive = ['config', 'env', 'projects', 'fields', 'service', 'remote', 'stack', 'stackAt', 'models', 'update', 'health'];
    for (const key of [queryKeys.overview, queryKeys.sessions, queryKeys.allUsage]) {
      expect(reachedBy(key).filter((name) => expensive.includes(name))).toEqual([]);
    }
  });
});
