import type { AgentModels } from './config-types';

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  thinking: number;
}
export interface ModelUsage extends Usage {
  model: string;
  requests: number;
}
export type ToolCounts = Record<string, number>;

export interface Stats {
  usage: Usage;
  byModel: ModelUsage[];
  toolCounts: ToolCounts;
  startedAt?: string;
  lastAt?: string;
  turns: number;
  contextTokens: number;
  lastText: string;
}

export interface AgentSummary extends Stats {
  agentId: string;
  prompt: string;
  description?: string;
  subagentType?: string;
  model?: string;
  toolUseId?: string;
}

export interface WatcherState {
  state?: string;
  since?: number;
  step?: string;
  note?: string;
  branch?: string;
  pr?: string;
  servers?: string;
}
/** A finished run's app kept alive behind a tunnel — `~/.sloth/sessions/<repo>/issue-<n>/preview-state.json`. */
export interface PreviewState {
  issue: number;
  /** The PR the link was posted on; absent, the comment went on the issue. */
  pr?: number;
  /** The public address, once the tunnel printed it. */
  url?: string;
  /** The key the guard in front of the app wants (see `runner/preview-proxy.ts`); it is in the posted link. */
  key: string;
  commentId?: number;
  startedAt: number;
  expiresAt: number;
}
export interface WatcherSession {
  name: string;
  kind: 'issue' | 'review' | 'approved';
  target: number;
  pid?: number;
  alive: boolean;
  sessionId?: string;
  state?: WatcherState;
  preview?: PreviewState;
  retries: number;
  blocked: boolean;
  /** The issue a review / approved run was started for — the server writes it into the directory. */
  issue?: number;
  runLogTail: string;
  inbox: string[];
  updatedAt?: string;
}

/** A configured slash command name (see SLOTH_COMMANDS), or 'other' when the prompt matches none. */
export type SessionKind = string;
export type SessionStatus = 'running' | 'waiting' | 'parked' | 'done';
export interface SessionSummary extends Stats {
  id: string;
  prompt: string;
  kind: SessionKind;
  target?: number;
  title?: string;
  status: SessionStatus;
  live: boolean;
  agents: AgentSummary[];
  agentsUsage: Usage;
  watcher?: WatcherSession;
  /** USD at list price for this run and its subagents; null when one of its models has no known price. */
  cost: number | null;
}

/** What one issue has cost so far — every run Sloth started on it, rolled up. */
export interface IssueCost {
  issue: number;
  title?: string;
  sessions: number;
  cost: number | null;
  tokens: { input: number; output: number; cacheRead: number };
  lastAt?: string;
  /** The status of the newest run on the issue. */
  status?: SessionStatus;
}

export type Block =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown; agentId?: string }
  | { type: 'tool_result'; toolUseId: string; content: string; isError: boolean; truncated: boolean };
export interface Message {
  uuid: string;
  role: 'user' | 'assistant';
  timestamp: string;
  blocks: Block[];
  model?: string;
  usage?: Usage;
}
export interface SessionDetail extends SessionSummary {
  messages: Message[];
}
export interface AgentDetail extends AgentSummary {
  messages: Message[];
}

export interface RateBucket {
  remaining: number;
  limit: number;
  reset: number;
}
export interface MonitorConfig {
  repo: string;
  title: string;
  runnerRoot: string;
  transcriptsDir: string;
  commands: Record<string, string>;
  boardSeconds: number;
  commentSeconds: number;
  pickupColumn: string;
  maxActive: number;
  maxAlive: number;
  models: AgentModels;
}

/** What the in-process board loop is doing, for the header pills. */
export interface LoopStatus {
  running: boolean;
  ticking: boolean;
  lastBoard?: number;
  lastComment?: number;
  nextBoard?: number;
  nextComment?: number;
}

/** Remote access: where the UI is reachable from outside once the tunnel is up, or why it is not. */
export interface RemoteStatus {
  url?: string;
  error?: string;
}
export interface InstallStatus {
  running: boolean;
  /** The last lines brew printed. */
  output: string;
  error?: string;
}
/** The QR code's payload — the address with the secret that signs a phone in — and what stands in its way. */
export interface RemoteLink extends RemoteStatus {
  link?: string;
  /** The tunnel tool; absent when `publicUrl` is set and no tool is needed. */
  tool?: { command: string; installed: boolean; installable: boolean };
  install: InstallStatus;
}

/** The update the settings page started: which step it is on, the last lines it printed, how it ended. */
export interface UpdateStatus {
  running: boolean;
  step?: 'pull' | 'install' | 'build' | 'restart';
  output: string;
  error?: string;
  /** The new process is starting; the page reloads once it answers. */
  restarting: boolean;
}
/** What Sloth this is: the version in package.json, the commit of the checkout, and how far behind the remote it is. */
export interface VersionInfo {
  version: string;
  commit?: string;
  date?: string;
  branch?: string;
  /** Tracked files changed in the checkout — a pull may refuse. */
  dirty: boolean;
  /** Commits on origin/<branch> this checkout lacks; unknown until a check ran. */
  behind?: number;
  checkedAt?: string;
  checkError?: string;
  update: UpdateStatus;
}

/** The launch agent that starts Sloth at login — Settings → Machine shows this. */
export interface ServiceStatus {
  /** Only macOS has an implementation; elsewhere the toggle saves and does nothing. */
  supported: boolean;
  installed: boolean;
  label: string;
  plist: string;
  /** Why the last change failed — a missing build, mostly. */
  error?: string;
}

export interface Overview {
  generatedAt: string;
  config: MonitorConfig;
  remote: RemoteStatus;
  watcher: {
    logTail: string[];
    lastTick?: string;
    /** The user's pause — set from the header, kept in ~/.sloth/state/paused. */
    paused: boolean;
    pausedUntil?: number;
    seen: number;
    reviewed: number;
    loop: LoopStatus;
  };
  rateLimit?: Record<string, RateBucket>;
  sessions: SessionSummary[];
  orphans: WatcherSession[];
  /** Per-issue rollup of everything above, dearest first. */
  issues: IssueCost[];
}

export interface UsageBucket {
  hour: string;
  newInput: number;
  cacheRead: number;
  output: number;
  /** USD at API list price for the priced models in this hour. */
  cost: number;
}
/** `cost` is null for a model with no known list price — its tokens still count, its dollars don't. */
export interface ModelCost {
  model: string;
  cost: number | null;
}
export interface UsageSeries {
  from: string;
  to: string;
  buckets: UsageBucket[];
  /** What the whole window would have cost on API billing, summed over `byModel`. */
  cost: number;
  byModel: ModelCost[];
}
