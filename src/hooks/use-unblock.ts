import { useMutation, useQueryClient } from '@tanstack/react-query';

/**
 * Lifts the block on one card: the give-up, the "already tested this head" markers and the run's count of
 * verdict-less tests all go, so the next QA sweep meets the card as if it had never been tested.
 */
export default function useUnblock() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (issue: number) => {
      const res = await fetch(`/api/issues/${issue}/unblock`, { method: 'POST' });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      return res.json() as Promise<{ ok: boolean; issue: number }>;
    },
    onSuccess: () => queryClient.invalidateQueries(),
  });
}
