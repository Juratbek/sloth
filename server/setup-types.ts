/** What the get-started wizard and `/api/setup/*` pass each other. Split out of `config-types.ts`,
 *  which re-exports all of it. */

import type { BoardProvider, ColumnRef } from './config-types';

export interface SetupCheck {
  ok: boolean;
  version?: string;
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
