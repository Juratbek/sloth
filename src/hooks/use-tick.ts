import { useMutation, useQueryClient } from '@tanstack/react-query';
import { invalidateLive } from '../lib/live-keys';

/** Asks the watcher to run its next tick now — reap and deliveries even while paused. */
export default function useTick() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/tick', { method: 'POST' });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      return res.json() as Promise<{ ok: boolean }>;
    },
    onSuccess: () => invalidateLive(queryClient),
  });
}
