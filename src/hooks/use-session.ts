import { useQuery } from '@tanstack/react-query';
import type { SessionDetail } from '../../server/types';
import { fetchJson } from '../lib/api';
import { queryKeys } from '../lib/query-keys';

/**
 * One run's transcript. `every` is how often it is re-read while the run is going — the Stack page
 * watches a live install closely.
 *
 * A finished run stops polling: its transcript is a file that will not change again, and the tab left
 * open on it re-read the whole thing every ten seconds for as long as the browser stayed open. Should
 * anything write to it after all, the SSE stream invalidates this key and the answer arrives anyway.
 */
export default function useSession(id: string, every = 10_000) {
  return useQuery({
    queryKey: queryKeys.session(id),
    queryFn: () => fetchJson<SessionDetail>(`/api/sessions/${id}`),
    refetchInterval: (query) => {
      const s = query.state.data;
      return !s || s.live || s.status === 'running' || s.status === 'waiting' ? every : false;
    },
  });
}
