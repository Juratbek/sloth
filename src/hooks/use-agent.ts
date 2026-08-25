import { useQuery } from '@tanstack/react-query';
import type { AgentDetail } from '../../server/types';
import { fetchJson } from '../lib/api';

export const AGENT_QUERY_KEY = (id: string, agentId: string) => ['session', id, 'agent', agentId] as const;

export default function useAgent(id: string, agentId: string) {
  return useQuery({
    queryKey: AGENT_QUERY_KEY(id, agentId),
    queryFn: () => fetchJson<AgentDetail>(`/api/sessions/${id}/agents/${agentId}`),
    refetchInterval: 10_000,
  });
}
