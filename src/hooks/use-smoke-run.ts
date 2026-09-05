import { useMutation, useQueryClient } from '@tanstack/react-query';
import { postJson } from '../lib/api';
import { invalidateLive } from '../lib/live-keys';

/** Asks for a smoke test now, whatever the schedule says, and ticks the board so it starts. */
export default function useSmokeRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => postJson<{ ok: boolean; running: boolean }>('/api/smoke/run', {}),
    onSuccess: () => invalidateLive(queryClient),
  });
}
