import { useMutation, useQueryClient } from '@tanstack/react-query';
import { postJson } from '../lib/api';

/** Takes an issue's preview down now — tunnel, servers, database and worktree — instead of at its expiry. */
export default function useStopPreview() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (issue: number) => postJson<{ ok: boolean }>(`/api/previews/${issue}/stop`, {}),
    onSuccess: () => queryClient.invalidateQueries(),
  });
}
