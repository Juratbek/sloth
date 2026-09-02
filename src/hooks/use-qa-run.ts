import { useMutation, useQueryClient } from '@tanstack/react-query';
import { postJson } from '../lib/api';
import { invalidateLive } from '../lib/live-keys';

/** Opens a QA sweep now, whatever the clock says, and ticks the board so its sessions start. */
export default function useQaRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => postJson<{ ok: boolean }>('/api/qa/run', {}),
    onSuccess: () => invalidateLive(queryClient),
  });
}
