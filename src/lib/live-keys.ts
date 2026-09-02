import type { QueryClient } from '@tanstack/react-query';
import { queryKeys } from './query-keys';

/**
 * The queries a live change touches: what a running session writes, and nothing else.
 *
 * `invalidateQueries()` with no filter refetches *every* mounted query and ignores `staleTime`. On the
 * SSE stream — one message per transcript append, roughly one a second while a session runs — that puts
 * the wizard's and the settings' shell-outs (`gh api graphql` over 50 projects and 20 orgs, `gh auth
 * status`, `claude --version`) on the same beat and spends the GraphQL bucket. These keys are prefixes:
 * `queryKeys.sessions` covers a session and its agents, `queryKeys.allUsage` every window of the series.
 * The board has no key of its own — it comes down inside the overview.
 */
const LIVE_KEYS = [queryKeys.overview, queryKeys.sessions, queryKeys.allUsage];

/** Refetches what the server just changed, leaving the config, project and environment queries alone. */
export function invalidateLive(queryClient: QueryClient): void {
  for (const queryKey of LIVE_KEYS) void queryClient.invalidateQueries({ queryKey });
}
