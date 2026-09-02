import { useMutation, useQueryClient } from '@tanstack/react-query';
import { postJson } from '../lib/api';
import { queryKeys } from '../lib/query-keys';

/** Ends the run behind a transcript now. An issue's card is parked, so Sloth does not start it again. */
export default function useStopSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => postJson<{ ok: boolean; stopped: boolean }>(`/api/sessions/${id}/stop`, {}),
    // The run that stopped and the list it is on — its last tokens are already in the usage series.
    onSuccess: (_data, id) => {
      for (const queryKey of [queryKeys.overview, queryKeys.session(id)]) void queryClient.invalidateQueries({ queryKey });
    },
  });
}
