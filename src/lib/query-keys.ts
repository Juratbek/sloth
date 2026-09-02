/**
 * Every key the UI caches under, in one place.
 *
 * Keys are prefixes of one another on purpose: `['session', id]` sits under `sessions`, and
 * `['session', id, 'agent', agentId]` under both, so one `invalidateQueries({ queryKey: sessions })`
 * reaches a session and its subagents without listing them. That nesting is the whole reason the keys
 * live here rather than beside their hooks — an invalidation is only as scoped as the key it is given,
 * and a key written twice drifts. `test/query-keys.test.ts` pins the prefix relationships down.
 *
 * There is no `board` key: the board comes down inside the overview, so `overview` is its key too.
 */
export const queryKeys = {
  /** The watcher, the board, the session list, the blocked cards — one poll, one key. */
  overview: ['overview'] as const,
  /** Prefix over every session and every subagent of one. */
  sessions: ['session'] as const,
  session: (id: string) => ['session', id] as const,
  agent: (id: string, agentId: string) => ['session', id, 'agent', agentId] as const,
  /** Prefix over every window of the usage series. */
  allUsage: ['usage'] as const,
  usage: (days: number) => ['usage', days] as const,
  /** The models this machine can reach — a `claude --version` and the provider keys behind it. */
  models: ['models'] as const,
  /**
   * Whether this machine can do the work — `gh`, `origin`, the browser, sudo. Deliberately not a live
   * key: the server caches the answer for ten minutes and re-taking it shells out to `gh` and `git`.
   */
  health: ['health'] as const,
  /** The phone tunnel: the tool, its install and the link. */
  remote: ['remote'] as const,
  /** Prefix over the stack as judged against any checkout. */
  allStack: ['stack'] as const,
  /** The stack as judged against a checkout; the configured one when `root` is absent. */
  stack: (root?: string) => ['stack', root ?? ''] as const,
  /** The version, how far behind origin it is, and the update in flight. */
  update: ['update'] as const,
  /** Whether this machine starts Sloth at login. */
  service: ['service'] as const,
  /** Prefix over everything the wizard asks the server — each one shells out to `gh`. */
  setup: ['setup'] as const,
  setupConfig: ['setup', 'config'] as const,
  setupEnv: ['setup', 'env'] as const,
  setupProjects: ['setup', 'projects'] as const,
  setupFields: (projectId: string | undefined) => ['setup', 'fields', projectId] as const,
};
