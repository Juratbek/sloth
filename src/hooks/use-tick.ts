import { useMutation, useQueryClient } from '@tanstack/react-query';

/** The monitor's only write: asks the watcher to run its next tick now. */
export default function useTick() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/tick', { method: 'POST' });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      return res.json() as Promise<{ ok: boolean }>;
    },
    onSuccess: () => queryClient.invalidateQueries(),
  });
}
