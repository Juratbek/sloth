import { useMutation, useQueryClient } from '@tanstack/react-query';
import { postJson } from '../lib/api';
import { invalidateLive } from '../lib/live-keys';

/** Ends the run behind a transcript now. An issue's card is parked, so Sloth does not start it again. */
export default function useStopSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => postJson<{ ok: boolean; stopped: boolean }>(`/api/sessions/${id}/stop`, {}),
    onSuccess: () => invalidateLive(queryClient),
  });
}
