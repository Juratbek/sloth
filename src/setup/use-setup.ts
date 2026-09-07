import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnRef, ConfigProject, RepoConfig, SetupEnv, SetupFields, SetupProject, SetupRepo, SlothConfig, StackChoice } from '../../server/config-types';
import { fetchJson, postJson } from '../lib/api';
import { queryKeys } from '../lib/query-keys';

/**
 * What the wizard posts: the values it asks about, plus whatever the saved config already had.
 * Everything else (directories, budgets, poll intervals) gets its default on the server.
 */
export type ConfigPayload = Pick<SlothConfig, 'repos' | 'project' | 'statusField' | 'roles' | 'maxActive' | 'maxAlive'> & Partial<SlothConfig>;

/** The draft the wizard carries between steps; becomes the saved config on the last one. */
export interface Draft {
  /** The repositories the sessions work in, in the order they were picked — the first is where a run with no card of its own works. */
  repos: RepoConfig[];
  project?: ConfigProject;
  statusFieldId?: string;
  pickup?: ColumnRef;
  /** A column with an empty id is one Sloth creates on the board when the config is saved. */
  inProgress?: ColumnRef;
  needsHelp?: ColumnRef;
  codeReview?: ColumnRef;
  approved?: ColumnRef;
  /** Opt-in: the column the daily QA sweep tests; `{id:'', name:''}` means none. */
  qa?: ColumnRef;
  done?: ColumnRef;
  /** The team: one admin, developers, testers (see server/roles.ts). */
  admin: string;
  developers: string[];
  testers: string[];
  maxActive: number;
  maxAlive: number;
  /** How long a finished session's app stays reachable behind a link on its PR; 0 = no previews. */
  previewHours: number;
  /** What the app needs on this machine — `auto` reads it off the checkout. */
  stack: StackChoice;
  /** Who hears about a card landing in needs help: `@`-mentioned logins, and an optional webhook URL. */
  helpLogins: string[];
  helpWebhook: string;
}

export const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
/** Where a repository's checkout goes unless the user says otherwise: under the runners directory, by name. */
export const defaultRoot = (slug: string, home = '~/.sloth') => `${home}/runners/${slug.split('/')[1] ?? slug}`;
/** A repository as the picker adds it: its slug, no note yet, its checkout at the default place. */
export const newRepo = (slug: string, home = '~/.sloth'): RepoConfig => ({ slug, note: '', root: defaultRoot(slug, home) });

export const draftFrom = (config: SlothConfig | null | undefined): Draft => ({
  repos: config?.repos ?? [],
  project: config?.project,
  statusFieldId: config?.statusField.id,
  pickup: config?.statusField.columns.pickup,
  inProgress: config?.statusField.columns.inProgress,
  needsHelp: config?.statusField.columns.needsHelp,
  codeReview: config?.statusField.columns.codeReview,
  // An older config has no Approved column; the wizard offers to create one.
  approved: config?.statusField.columns.approved?.id ? config.statusField.columns.approved : undefined,
  qa: config?.statusField.columns.qa?.id ? config.statusField.columns.qa : undefined,
  done: config?.statusField.columns.done?.id ? config.statusField.columns.done : undefined,
  admin: config?.roles.admin ?? '',
  developers: config?.roles.developers ?? [],
  testers: config?.roles.testers ?? [],
  maxActive: config?.maxActive ?? 3,
  maxAlive: config?.maxAlive ?? 5,
  previewHours: config?.previewHours ?? 24,
  stack: config?.stack ?? 'auto',
  helpLogins: config?.helpLogins ?? [],
  helpWebhook: config?.helpWebhook ?? '',
});
/** The saved config, or null when the user has not been through the wizard yet. */
/** The saved config, for the wizard. Only the machine Sloth runs on may read it — a phone never asks. */
export function useConfig(enabled = true) {
  return useQuery({
    queryKey: queryKeys.setupConfig,
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

/**
 * Re-read on every mount, but kept between the steps: the Team step prefills the admin with the login
 * this reading found, and would otherwise sit empty while `gh` is asked again.
 */
export function useSetupEnv() {
  return useQuery({
    queryKey: queryKeys.setupEnv,
    queryFn: () => fetchJson<SetupEnv>('/api/setup/env'),
    staleTime: 0,
    retry: false,
  });
}

export function useProjects() {
  return useQuery({
    queryKey: queryKeys.setupProjects,
    queryFn: () => fetchJson<SetupProject[]>('/api/setup/projects'),
    staleTime: 60_000,
    retry: false,
  });
}

/** The repositories the picker lists; one reading serves the wizard's step and the settings section both. */
export function useAccessibleRepos() {
  return useQuery({
    queryKey: queryKeys.setupRepos,
    queryFn: () => fetchJson<SetupRepo[]>('/api/setup/repos'),
    staleTime: 60_000,
    retry: false,
  });
}

export function useProjectFields(projectId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.setupFields(projectId),
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

/**
 * Writes the whole config. What a save changes is named rather than swept up by a bare
 * `invalidateQueries()`: the server validates the config, creates the columns still to be created and
 * restarts the watcher and the tunnel on the new values, so the config itself, the overview, the QR and
 * the stack judged against the (possibly new) checkout are all stale — and nothing else is. The
 * transcripts a save cannot touch are left where they are.
 */
export function useSaveConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (config: ConfigPayload) => postJson<{ ok: boolean; path: string; config: SlothConfig }>('/api/setup/config', config),
    onSuccess: () => {
      for (const queryKey of [queryKeys.setup, queryKeys.overview, queryKeys.remote, queryKeys.allStack, queryKeys.service]) {
        void queryClient.invalidateQueries({ queryKey });
      }
    },
  });
}
