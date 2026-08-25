import { useQuery } from '@tanstack/react-query';
import type { SessionDetail } from '../../server/types';
import { fetchJson } from '../lib/api';

export const SESSION_QUERY_KEY = (id: string) => ['session', id] as const;

export default function useSession(id: string) {
  return useQuery({
    queryKey: SESSION_QUERY_KEY(id),
    queryFn: () => fetchJson<SessionDetail>(`/api/sessions/${id}`),
    refetchInterval: 10_000,
  });
}
