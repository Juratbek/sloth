import { useMutation, useQueryClient } from '@tanstack/react-query';
import { postJson } from '../lib/api';
import { invalidateLive } from '../lib/live-keys';

/** Asks the watcher to run its next tick now — reap and deliveries even while paused. */
export default function useTick() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => postJson<{ ok: boolean }>('/api/tick', {}),
    onSuccess: () => invalidateLive(queryClient),
  });
}
