import { useMutation, useQueryClient } from '@tanstack/react-query';

/** Opens a QA sweep now, whatever the clock says, and ticks the board so its sessions start. */
export default function useQaRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/qa/run', { method: 'POST' });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      return res.json() as Promise<{ ok: boolean }>;
    },
    onSuccess: () => queryClient.invalidateQueries(),
  });
}
