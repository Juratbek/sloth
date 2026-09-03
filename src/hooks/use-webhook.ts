import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WebhookInfo } from '../../server/types';
import { fetchJson, postJson } from '../lib/api';
import { queryKeys } from '../lib/query-keys';

/**
 * The repository webhook Sloth configures for itself: whether GitHub is delivering `@sloth` comments
 * here, why it is not, and which of the two comment polls that puts in force.
 *
 * Read straight out of the server's own memory — no `gh` call, so it is cheap enough to keep fresh
 * while the settings page is open, which is where a tunnel that just came back on a new address shows
 * up as "the public address changed".
 */
export function useWebhook() {
  return useQuery({
    queryKey: queryKeys.webhook,
    queryFn: () => fetchJson<WebhookInfo>('/api/webhook'),
    refetchInterval: 15_000,
    retry: false,
  });
}

/** Configures it again now — the address changed, the token was fixed, a human deleted the hook. */
export function useRetryWebhook() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => postJson<WebhookInfo>('/api/webhook/retry', {}),
    onSuccess: (info) => queryClient.setQueryData(queryKeys.webhook, info),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.webhook }),
  });
}
