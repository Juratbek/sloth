/** What the get-started wizard and `/api/setup/*` pass each other. Split out of `config-types.ts`,
 *  which re-exports all of it. */

import type { ColumnRef } from './config-types';

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
