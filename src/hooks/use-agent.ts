import { useQuery } from '@tanstack/react-query';
import type { AgentDetail } from '../../server/types';
import { fetchJson } from '../lib/api';
import { queryKeys } from '../lib/query-keys';

export default function useAgent(id: string, agentId: string) {
  return useQuery({
    queryKey: queryKeys.agent(id, agentId),
    queryFn: () => fetchJson<AgentDetail>(`/api/sessions/${id}/agents/${agentId}`),
    refetchInterval: 10_000,
  });
}
