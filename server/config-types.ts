/** The saved configuration (~/.sloth/config.json, path overridden with SLOTH_CONFIG) and the
 *  payloads the get-started wizard exchanges with /api/setup/*. */

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
  needsHelp: ColumnRef;
  codeReview: ColumnRef;
  /** Optional: with no Approved column trigger 5 never fires. */
  approved: ColumnRef;
}
export type ColumnRole = keyof ConfigColumns;

/** The names Sloth gives the columns it creates when the board has none for a role. */
export const DEFAULT_COLUMN_NAMES: Record<ColumnRole, string> = {
  pickup: 'Todo',
  inProgress: 'In Progress',
  needsHelp: 'Sloth needs help',
  codeReview: 'Code Review',
  approved: 'Approved',
};

/** One admin, any number of developers and testers. A login holds one role: admin wins, then developer. */
export interface Roles {
  /** Orders anything — work, board moves, closing issues. Empty means nobody can. */
  admin: string;
  /** Order work on an issue, within that issue. */
  developers: string[];
  /** Answer a parked card's questions and ask for status; never order. */
  testers: string[];
}

/**
 * Which model each of Sloth's agents runs on — a Claude Code `--model` value: an alias (`opus`, `fable`)
 * or a full model id. Settings → Models edits it.
 */
export interface AgentModels {
  /** The implement session: claims the card, writes the code, opens the PR (triggers 1–3). */
  implement: string;
  /** The tester subagent an implement session spawns to click through the change in Chrome. */
  tester: string;
  /** The reviewer subagent an implement session asks before it hands the PR over. */
  reviewer: string;
  /** `/sloth:review` of a human's PR in Code Review (trigger 4). */
  review: string;
  /** `/sloth:review … final` of an Approved card's PR (trigger 5). */
  final: string;
  /** `/sloth:status`: the reply to an @sloth question when no session is running. */
  status: string;
}
export type AgentRole = keyof AgentModels;

export const DEFAULT_MODELS: AgentModels = { implement: 'opus', tester: 'opus', reviewer: 'opus', review: 'opus', final: 'fable', status: 'opus' };
export const AGENT_ROLES = Object.keys(DEFAULT_MODELS) as AgentRole[];

export interface SlothConfig {
  version: 1;
  repo: string;
  project: ConfigProject;
  statusField: { id: string; columns: ConfigColumns };
  /** The checkout the sessions run from; Sloth clones the repo here. */
  runnerRoot: string;
  runnersDir: string;
  worktreesDir: string;
  sessionsDir: string;
  stateDir: string;
  watcherLog: string;
  /** Who may talk to Sloth (see `roles.ts`); a saved `orderLogin` from an older config loads as the admin. */
  roles: Roles;
  mention: string;
  botPrefix: string;
  maxActive: number;
  maxAlive: number;
  budgetMinutes: number;
  waitHours: number;
  reviewRounds: number;
  maxRetries: number;
  boardSeconds: number;
  commentSeconds: number;
  /** One model per agent; a config from before this had `model` for every session and `approvedModel` for the final review. */
  models: AgentModels;
  /** Pass `--chrome` to implement sessions, so a tester subagent can exercise the change in the user's Chrome. */
  chrome: boolean;
  /**
   * How long a finished implement session's app stays up behind a public link posted on its PR, so a
   * reviewer can try the change without checking it out (see `runner/preview.ts`). `0` turns previews off.
   */
  previewHours: number;
  /** GitHub logins `@`-mentioned in the comment Sloth writes when it parks a card in the needs-help column. */
  helpLogins: string[];
  /** Optional URL POSTed (Slack / Discord incoming-webhook shape) when a card lands in the needs-help column. */
  helpWebhook: string;
  /** The argv Sloth runs to reach the UI from outside; `{port}` is the UI's port. The first bare https URL it prints is the address. */
  tunnel: string[];
  /** Where the UI is already reachable (your own tunnel or domain). Set, no tunnel is started. */
  publicUrl: string;
}

export const DEFAULT_TUNNEL = ['cloudflared', 'tunnel', '--url', 'http://localhost:{port}'];

/**
 * Every value with a default: what a saved config gets when it leaves the key out, and what Settings'
 * "Restore defaults" puts back. The per-repository directories are `defaultDirs`.
 */
export const CONFIG_DEFAULTS = {
  runnersDir: '~/.sloth/runners',
  stateDir: '~/.sloth/state',
  watcherLog: '~/.sloth/watcher.log',
  mention: '@sloth',
  botPrefix: '**Sloth:**',
  maxActive: 3,
  maxAlive: 5,
  budgetMinutes: 60,
  waitHours: 2,
  reviewRounds: 4,
  maxRetries: 2,
  boardSeconds: 300,
  commentSeconds: 120,
  models: DEFAULT_MODELS,
  chrome: true,
  previewHours: 24,
  helpLogins: [] as string[],
  helpWebhook: '',
  tunnel: DEFAULT_TUNNEL,
  publicUrl: '',
} satisfies Partial<SlothConfig>;

/** The directories that are kept apart per repository (`name` is the part after the slash). */
export const defaultDirs = (name: string) => ({
  runnerRoot: `~/.sloth/runners/${name}`,
  worktreesDir: `~/.sloth/worktrees/${name}`,
  sessionsDir: `~/.sloth/sessions/${name}`,
});

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
export interface FieldOption extends ColumnRef {
  color?: string;
  description?: string;
}
export interface SetupFields {
  statusField?: { id: string; name: string; options: FieldOption[] };
  repositories: string[];
}
