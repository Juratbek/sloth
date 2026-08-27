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
  model: string;
  /** The model the Approved reviews run on; every other session runs on `model`. */
  approvedModel: string;
  /** Pass `--chrome` to implement sessions, so a tester subagent can exercise the change in the user's Chrome. */
  chrome: boolean;
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
