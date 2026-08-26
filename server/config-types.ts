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
  /** The only gh login whose `@sloth` comments are orders. Anyone may ask for status. */
  orderLogin: string;
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
  /** The project's own slash command (no slash) trigger 5 runs on an Approved card's PR — e.g. `review` for `/review <pr>`. */
  approvedCommand: string;
  /** The model the Approved reviews run on; every other session runs on `model`. */
  approvedModel: string;
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
export interface FieldOption extends ColumnRef {
  color?: string;
  description?: string;
}
export interface SetupFields {
  statusField?: { id: string; name: string; options: FieldOption[] };
  repositories: string[];
}
