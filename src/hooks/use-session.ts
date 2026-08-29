import { useQuery } from '@tanstack/react-query';
import type { SessionDetail } from '../../server/types';
import { fetchJson } from '../lib/api';

export const SESSION_QUERY_KEY = (id: string) => ['session', id] as const;

/** `every` is how often the transcript is re-read — the Stack page watches a live install closely. */
export default function useSession(id: string, every = 10_000) {
  return useQuery({
    queryKey: SESSION_QUERY_KEY(id),
    queryFn: () => fetchJson<SessionDetail>(`/api/sessions/${id}`),
    refetchInterval: every,
  });
}
