import { useMutation, useQueryClient } from '@tanstack/react-query';
import { postJson } from '../lib/api';

/** Pauses or resumes the launching triggers — Sloth keeps running, it just starts nothing new. */
export default function usePause() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (paused: boolean) => postJson<{ paused: boolean }>(paused ? '/api/pause' : '/api/resume', {}),
    onSuccess: () => queryClient.invalidateQueries(),
  });
}
