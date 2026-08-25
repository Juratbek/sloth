import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnRef, ConfigProject, SetupEnv, SetupFields, SetupProject, SlothConfig } from '../../server/types';
import { fetchJson, postJson } from '../lib/api';

export const CONFIG_QUERY_KEY = ['setup', 'config'] as const;

/** The draft the wizard carries between steps; becomes the saved config on the last one. */
export interface Draft {
  repo: string;
  project?: ConfigProject;
  statusFieldId?: string;
  pickup?: ColumnRef;
  inProgress?: ColumnRef;
  needsHelp?: ColumnRef | null;
  codeReview?: ColumnRef;
  runnerRoot: string;
  maxActive: number;
  maxAlive: number;
}

export const draftFrom = (config: SlothConfig | null | undefined): Draft => ({
  repo: config?.repo ?? '',
  project: config?.project,
  statusFieldId: config?.statusField.id,
  pickup: config?.statusField.columns.pickup,
  inProgress: config?.statusField.columns.inProgress,
  needsHelp: config?.statusField.columns.needsHelp ?? null,
  codeReview: config?.statusField.columns.codeReview,
  runnerRoot: config?.runnerRoot ?? '',
  maxActive: config?.maxActive ?? 3,
  maxAlive: config?.maxAlive ?? 5,
});

/** The saved config, or null when the user has not been through the wizard yet. */
export function useConfig() {
  return useQuery({
    queryKey: CONFIG_QUERY_KEY,
    queryFn: async () => {
      const res = await fetch('/api/setup/config');
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      return (await res.json()) as SlothConfig;
    },
    staleTime: Infinity,
  });
}

export function useSetupEnv() {
  return useQuery({
    queryKey: ['setup', 'env'],
    queryFn: () => fetchJson<SetupEnv>('/api/setup/env'),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}

export function useProjects() {
  return useQuery({
    queryKey: ['setup', 'projects'],
    queryFn: () => fetchJson<SetupProject[]>('/api/setup/projects'),
    staleTime: 60_000,
    retry: false,
  });
}

export function useProjectFields(projectId: string | undefined) {
  return useQuery({
    queryKey: ['setup', 'fields', projectId],
    queryFn: () => fetchJson<SetupFields>(`/api/setup/projects/${projectId}/fields`),
    enabled: !!projectId,
    staleTime: 60_000,
    retry: false,
  });
}

export function useClone() {
  return useMutation({
    mutationFn: (body: { repo: string; path: string }) =>
      postJson<{ ok: boolean; path?: string; error?: string }>('/api/setup/clone', body),
  });
}

export function useSaveConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (config: Omit<SlothConfig, 'version'>) => postJson<{ ok: boolean; path: string }>('/api/setup/config', config),
    onSuccess: () => queryClient.invalidateQueries(),
  });
}
