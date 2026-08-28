import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnRef, ConfigProject, SetupEnv, SetupFields, SetupProject, SlothConfig } from '../../server/config-types';
import { fetchJson, postJson } from '../lib/api';

export const CONFIG_QUERY_KEY = ['setup', 'config'] as const;

/**
 * What the wizard posts: the values it asks about, plus whatever the saved config already had.
 * Everything else (directories, budgets, poll intervals) gets its default on the server.
 */
export type ConfigPayload = Pick<SlothConfig, 'repo' | 'project' | 'statusField' | 'runnerRoot' | 'roles' | 'maxActive' | 'maxAlive'> &
  Partial<SlothConfig>;

/** The draft the wizard carries between steps; becomes the saved config on the last one. */
export interface Draft {
  repo: string;
  project?: ConfigProject;
  statusFieldId?: string;
  pickup?: ColumnRef;
  /** A column with an empty id is one Sloth creates on the board when the config is saved. */
  inProgress?: ColumnRef;
  needsHelp?: ColumnRef;
  codeReview?: ColumnRef;
  approved?: ColumnRef;
  done?: ColumnRef;
  runnerRoot: string;
  /** The team: one admin, developers, testers (see server/roles.ts). */
  admin: string;
  developers: string[];
  testers: string[];
  maxActive: number;
  maxAlive: number;
  /** How long a finished session's app stays reachable behind a link on its PR; 0 = no previews. */
  previewHours: number;
  /** Who hears about a card landing in needs help: `@`-mentioned logins, and an optional webhook URL. */
  helpLogins: string[];
  helpWebhook: string;
}

export const draftFrom = (config: SlothConfig | null | undefined): Draft => ({
  repo: config?.repo ?? '',
  project: config?.project,
  statusFieldId: config?.statusField.id,
  pickup: config?.statusField.columns.pickup,
  inProgress: config?.statusField.columns.inProgress,
  needsHelp: config?.statusField.columns.needsHelp,
  codeReview: config?.statusField.columns.codeReview,
  // An older config has no Approved column; the wizard offers to create one.
  approved: config?.statusField.columns.approved?.id ? config.statusField.columns.approved : undefined,
  done: config?.statusField.columns.done?.id ? config.statusField.columns.done : undefined,
  runnerRoot: config?.runnerRoot ?? '',
  admin: config?.roles.admin ?? '',
  developers: config?.roles.developers ?? [],
  testers: config?.roles.testers ?? [],
  maxActive: config?.maxActive ?? 3,
  maxAlive: config?.maxAlive ?? 5,
  previewHours: config?.previewHours ?? 24,
  helpLogins: config?.helpLogins ?? [],
  helpWebhook: config?.helpWebhook ?? '',
});

/** The saved config, or null when the user has not been through the wizard yet. */
/** The saved config, for the wizard. Only the machine Sloth runs on may read it — a phone never asks. */
export function useConfig(enabled = true) {
  return useQuery({
    queryKey: CONFIG_QUERY_KEY,
    enabled,
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
    mutationFn: (config: ConfigPayload) => postJson<{ ok: boolean; path: string; config: SlothConfig }>('/api/setup/config', config),
    onSuccess: () => queryClient.invalidateQueries(),
  });
}
