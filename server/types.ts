import type { BlockedCard, BoardView } from './board-types';
import type { AgentModels } from './config-types';
import type { RemoteStatus } from './machine-types';

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
  /** The model the run answered on — the one behind most of its requests; absent until the first reply. */
  model?: string;
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
  /** `issue` implements, `approved` reviews a PR (`review` is that kind's older name), `qa` tests a card on the QA branch. */
  kind: 'issue' | 'review' | 'approved' | 'qa';
  target: number;
  pid?: number;
  alive: boolean;
  sessionId?: string;
  state?: WatcherState;
  preview?: PreviewState;
  retries: number;
  blocked: boolean;
  /** Set while the run is stopped for the machine's sake (`runner/pressure.ts`): since when, and the reading that did it. */
  paused?: { since: number; reason: string };
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
  /** The QA sweep as configured: its column (empty: none) and its time of day (empty: not scheduled). */
  qaColumn: string;
  qaAt: string;
}

/** The last reading of the machine's memory, CPU and disk (`runner/machine.ts`), taken before a tick may launch. */
export interface MachineLoad {
  /** Memory a new process could take, percent of the total. */
  memoryFree: number;
  /** CPU idle over the window since the previous reading, percent. */
  cpuIdle: number;
  /** The busiest disk's idle over the same window, percent — 100 minus what Task Manager calls *Disk*. */
  diskIdle: number;
  at: number;
  /** Set while the reading holds new sessions back — the reason, as the log prints it. */
  hold?: string;
}

/** What the in-process board loop is doing, for the header pills. */
export interface LoopStatus {
  running: boolean;
  ticking: boolean;
  machine?: MachineLoad;
  lastBoard?: number;
  lastComment?: number;
  nextBoard?: number;
  nextComment?: number;
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
  /** The board as the last tick read it, joined to the runs above; undefined until a tick has read it. */
  board?: BoardView;
  /** The cards Sloth has given up on, newest first — each one a row on the panel with an unblock button. */
  blocked: BlockedCard[];
}

/** Remote access, updates and the launch agent — what the machine itself reports (`machine-types.ts`). */
export type { InstallStatus, RemoteLink, RemoteStatus, ServiceStatus, StackStatus, StackTool, UpdateStatus, VersionInfo } from './machine-types';
/** The home panel's mirror of the GitHub board (`board-types.ts`). */
export type { BlockedCard, BoardCard, BoardColumn, BoardView } from './board-types';
/** The spend series behind the usage chart (`usage-types.ts`). */
export type { ModelCost, UsageBucket, UsageSeries } from './usage-types';
