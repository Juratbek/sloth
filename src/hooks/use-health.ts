import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Health } from '../../server/types';
import { fetchJson, postJson } from '../lib/api';
import { queryKeys } from '../lib/query-keys';

/**
 * Whether the machine Sloth runs on can actually do the work: `gh` signed in, the runner checkout's
 * `origin` reachable, a browser for the screenshots, sudo where the stack install needs it.
 *
 * The server holds one cached answer and re-takes it at most every ten minutes (`server/health.ts`), so
 * this only reads that cache — a five-minute stale time and no interval, because a poll would be asking
 * for something that cannot have changed. Nothing invalidates it live either: the checks shell out to
 * `gh` and `git`, and one SSE message a second must not put them on that beat.
 */
export function useHealth() {
  return useQuery({
    queryKey: queryKeys.health,
    queryFn: () => fetchJson<Health>('/api/health'),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** Re-runs the checks now — the header chip is the button. The fresh answer replaces the cached one. */
export function useCheckHealth() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => postJson<Health>('/api/health/check', {}),
    onSuccess: (health) => queryClient.setQueryData(queryKeys.health, health),
  });
}
