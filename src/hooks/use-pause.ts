import { useMutation, useQueryClient } from '@tanstack/react-query';
import { postJson } from '../lib/api';
import { queryKeys } from '../lib/query-keys';

/**
 * Pauses or resumes the launching triggers — Sloth keeps running, it just starts nothing new.
 *
 * Only the overview carries the paused flag: no transcript is written and no token is spent, so the
 * sessions and the usage series are exactly as they were.
 */
export default function usePause() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (paused: boolean) => postJson<{ paused: boolean }>(paused ? '/api/pause' : '/api/resume', {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.overview }),
  });
}
