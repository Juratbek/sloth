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
export interface WatcherSession {
  name: string;
  kind: 'issue' | 'review' | 'approved';
  target: number;
  pid?: number;
  alive: boolean;
  sessionId?: string;
  state?: WatcherState;
  retries: number;
  blocked: boolean;
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
  model: string;
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
}

export interface UsageBucket {
  hour: string;
  newInput: number;
  cacheRead: number;
  output: number;
}
export interface UsageSeries {
  from: string;
  to: string;
  buckets: UsageBucket[];
}
