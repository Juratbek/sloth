/** What the get-started wizard and `/api/setup/*` pass each other. Split out of `config-types.ts`,
 *  which re-exports all of it. */

import type { BoardProvider, ColumnRef } from './config-types';

export interface SetupCheck {
  ok: boolean;
  version?: string;
  /** The GitHub or Trello account; for the GitHub login, the name gh keeps locally is read even when the check fails. */
  login?: string;
  error?: string;
}
export interface SetupEnv {
  /** Where this instance's directories default to — `~/.sloth`, or beside a config file given by `SLOTH_CONFIG`. */
  home: string;
  claude: SetupCheck;
  gh: SetupCheck;
  ghAuth: SetupCheck;
  /** Only when a Trello key and token are in the environment: whether they open a Trello account. */
  trello?: SetupCheck;
}
/**
 * The `gh auth login` the wizard runs (`gh-login.ts`): while it runs, the one-time code and the URL to
 * enter it at; once it has exited, whether it worked. Nothing but `running: false` before the first one.
 */
export interface GhLogin {
  running: boolean;
  code?: string;
  url?: string;
  ok?: boolean;
  error?: string;
}
export interface SetupProject {
  provider: BoardProvider;
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

/**
 * One repository the logged-in GitHub account can reach, as the picker lists it. `permission` is what
 * that account may do in it: Sloth pushes branches and opens PRs, so `READ` and `TRIAGE` are shown but
 * cannot be ticked.
 */
export interface SetupRepo {
  slug: string;
  description: string;
  private: boolean;
  archived: boolean;
  permission: 'ADMIN' | 'MAINTAIN' | 'WRITE' | 'TRIAGE' | 'READ';
  /** When it was last pushed to, ISO — the order the list comes in. */
  pushedAt: string;
}
