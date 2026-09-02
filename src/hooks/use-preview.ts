import { useMutation, useQueryClient } from '@tanstack/react-query';
import { postJson } from '../lib/api';
import { queryKeys } from '../lib/query-keys';

/**
 * Takes an issue's preview down now — tunnel, servers, database and worktree — instead of at its expiry.
 *
 * The link hangs off the run's watcher state and off the board card, both of which come down inside the
 * overview; the session showing the link is not known here by id, so the sessions prefix covers it.
 */
export default function useStopPreview() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (issue: number) => postJson<{ ok: boolean }>(`/api/previews/${issue}/stop`, {}),
    onSuccess: () => {
      for (const queryKey of [queryKeys.overview, queryKeys.sessions]) void queryClient.invalidateQueries({ queryKey });
    },
  });
}
