import { useQuery } from '@tanstack/react-query';
import type { UsageSeries } from '../../server/types';
import { fetchJson } from '../lib/api';

export const USAGE_QUERY_KEY = (days: number) => ['usage', days] as const;

export default function useUsage(days = 7) {
  return useQuery({
    queryKey: USAGE_QUERY_KEY(days),
    queryFn: () => fetchJson<UsageSeries>(`/api/usage?days=${days}`),
    refetchInterval: 60_000,
  });
}
