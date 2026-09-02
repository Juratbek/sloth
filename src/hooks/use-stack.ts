import { useState } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
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

export interface Unlock {
  password: string;
  ids: StackId[];
}

/**
 * Spends the sudo password on `/etc/sudoers.d/sloth` and installs what is missing through an AI session.
 *
 * Deliberately not a react-query mutation. A mutation keeps its variables — here the password — in the
 * client's `MutationCache` until they are garbage-collected, five minutes on by default, where any
 * script or devtools console on the page can read them back off `getMutationCache()`. `reset()` does not
 * help: it detaches the observer and leaves the cached mutation, and the dialog is unmounted by then in
 * any case. A plain POST holds the password in one argument, which goes out of scope with the call; only
 * the stack status it answers with is put in the cache.
 */
export async function unlockStack(queryClient: QueryClient, root: string | undefined, v: Unlock): Promise<StackStatus> {
  const status = await postJson<StackStatus>(`/api/stack/unlock${root ? `?root=${encodeURIComponent(root)}` : ''}`, v);
  queryClient.setQueryData(key(root), status);
  return status;
}

/** `unlockStack` with the pending flag the dialog's button needs, and nothing kept between calls. */
export function useUnlockStack(root?: string) {
  const queryClient = useQueryClient();
  const [isPending, setPending] = useState(false);
  const unlock = async (v: Unlock): Promise<StackStatus> => {
    setPending(true);
    try {
      return await unlockStack(queryClient, root, v);
    } finally {
      setPending(false);
    }
  };
  return { unlock, isPending };
}
