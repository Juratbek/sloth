import { useQuery } from '@tanstack/react-query';
import type { UsageSeries } from '../../server/types';
import { fetchJson } from '../lib/api';
import { queryKeys } from '../lib/query-keys';

export default function useUsage(days = 7) {
  return useQuery({
    queryKey: queryKeys.usage(days),
    queryFn: () => fetchJson<UsageSeries>(`/api/usage?days=${days}`),
    refetchInterval: 60_000,
  });
}
