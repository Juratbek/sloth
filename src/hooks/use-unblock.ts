import { useMutation, useQueryClient } from '@tanstack/react-query';
import { postJson } from '../lib/api';
import { queryKeys } from '../lib/query-keys';

/**
 * Lifts the block on one card: the give-up, the "already tested this head" markers and the run's count of
 * verdict-less tests all go, so the next QA sweep meets the card as if it had never been tested.
 *
 * The blocked list lives on the overview and nowhere else; the sweep that acts on this is a later tick.
 */
export default function useUnblock() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (issue: number) => postJson<{ ok: boolean; issue: number }>(`/api/issues/${issue}/unblock`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.overview }),
  });
}
