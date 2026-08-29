import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { StackId } from '../../server/config-types';
import type { StackStatus } from '../../server/types';
import { fetchJson, postJson } from '../lib/api';

const key = (root?: string) => ['stack', root ?? ''] as const;

/** The stack as this machine has it, judged against the checkout at `root` (the configured one when empty). */
export function useStack(root?: string, enabled = true) {
  return useQuery({
    queryKey: key(root),
    queryFn: () => fetchJson<StackStatus>(`/api/stack${root ? `?root=${encodeURIComponent(root)}` : ''}`),
    enabled,
    retry: false,
    // Quicker while the package manager is talking, so its output and the moment a tool appears show up promptly.
    refetchInterval: (query) => (query.state.data?.install.running ? 1_500 : 10_000),
  });
}

/** Installs the given tools; the list refreshes by itself while the install runs. */
export function useInstallStack(root?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ids: StackId[]) => postJson<StackStatus>(`/api/stack/install${root ? `?root=${encodeURIComponent(root)}` : ''}`, { ids }),
    onSuccess: (data) => queryClient.setQueryData(key(root), data),
  });
}

/**
 * Spends the sudo password on `/etc/sudoers.d/sloth` and installs what is missing through an AI
 * session. The password is a mutation variable, which react-query keeps until the mutation is reset —
 * `SudoDialog` resets it the moment the call settles, so it does not linger in the query cache.
 */
export function useUnlockStack(root?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (v: { password: string; ids: StackId[] }) =>
      postJson<StackStatus>(`/api/stack/unlock${root ? `?root=${encodeURIComponent(root)}` : ''}`, v),
    onSuccess: (data) => queryClient.setQueryData(key(root), data),
  });
}
