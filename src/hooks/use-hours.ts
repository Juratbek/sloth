import { useQuery } from '@tanstack/react-query';
import type { HoursReport } from '../../server/types';
import { fetchJson } from '../lib/api';
import { queryKeys } from '../lib/query-keys';

/** One month of the hours ledger; an empty `month` is this month, as the server reads it. */
export default function useHours(month: string) {
  return useQuery({
    queryKey: queryKeys.hours(month),
    queryFn: () => fetchJson<HoursReport>(`/api/hours${month ? `?month=${month}` : ''}`),
    refetchInterval: 60_000,
  });
}
