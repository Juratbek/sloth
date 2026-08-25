import { useQuery } from '@tanstack/react-query';
import type { Overview } from '../../server/types';
import { fetchJson } from '../lib/api';

export const OVERVIEW_QUERY_KEY = ['overview'] as const;

export default function useOverview() {
  return useQuery({
    queryKey: OVERVIEW_QUERY_KEY,
    queryFn: () => fetchJson<Overview>('/api/overview'),
    refetchInterval: 15_000,
  });
}
