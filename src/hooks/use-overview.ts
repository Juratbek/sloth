import { useQuery } from '@tanstack/react-query';
import type { Overview } from '../../server/types';
import { fetchJson } from '../lib/api';
import { queryKeys } from '../lib/query-keys';

export default function useOverview() {
  return useQuery({
    queryKey: queryKeys.overview,
    queryFn: () => fetchJson<Overview>('/api/overview'),
    refetchInterval: 15_000,
  });
}
