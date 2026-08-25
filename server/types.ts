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
  kind: 'issue' | 'review';
  target: number;
  pid?: number;
  alive: boolean;
  sessionId?: string;
  state?: WatcherState;
  retries: number;
  kills: number;
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
  tickEnabled: boolean;
  tickSeconds: number;
  pickupColumn: string;
  maxActive: number;
  maxAlive: number;
  model: string;
}

export interface Overview {
  generatedAt: string;
  config: MonitorConfig;
  watcher: {
    logTail: string[];
    lastTick?: string;
    pausedUntil?: number;
    seen: number;
    reviewed: number;
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

/** ---- Saved configuration (~/.sloth/config.json, override with SLOTH_CONFIG) ---- */

export interface ColumnRef {
  id: string;
  name: string;
}
export interface ConfigProject {
  id: string;
  number: number;
  owner: string;
  title: string;
}
export interface ConfigColumns {
  pickup: ColumnRef;
  inProgress: ColumnRef;
  needsHelp: ColumnRef | null;
  codeReview: ColumnRef;
}
export interface SlothConfig {
  version: 1;
  repo: string;
  project: ConfigProject;
  statusField: { id: string; columns: ConfigColumns };
  runnerRoot: string;
  sessionsDir: string;
  stateDir: string;
  watcherLog: string;
  maxActive: number;
  maxAlive: number;
  tickSeconds: number;
  tickCommand: string[] | null;
  model: string;
}

/** ---- Get-started wizard payloads ---- */

export interface SetupCheck {
  ok: boolean;
  version?: string;
  login?: string;
  error?: string;
}
export interface SetupEnv {
  claude: SetupCheck;
  gh: SetupCheck;
  ghAuth: SetupCheck;
}
export interface SetupProject {
  id: string;
  number: number;
  title: string;
  url: string;
  owner: string;
  items: number;
}
export interface SetupFields {
  statusField?: { id: string; name: string; options: ColumnRef[] };
  repositories: string[];
}
