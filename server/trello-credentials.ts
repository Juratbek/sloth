import fs from 'node:fs';
import path from 'node:path';
import { writeAtomic } from './atomic';
import { SLOTH_HOME, envValue } from './env';

/**
 * Where the Trello key, token and secret come from. Set in the UI — the wizard's environment step or
 * Settings → Board — they live in `trello.json` beside the config file, owner-readable only, so a person
 * setting Sloth up never has to open an editor; the environment (`SLOTH_TRELLO_KEY` / `_TOKEN` /
 * `_SECRET`, `.env` included) still wins field by field for whoever prefers it. They are never sent back
 * to a page: `trelloInfo` says only whether they are there and where from.
 */

export const TRELLO_KEY = 'SLOTH_TRELLO_KEY';
export const TRELLO_TOKEN = 'SLOTH_TRELLO_TOKEN';
export const TRELLO_SECRET = 'SLOTH_TRELLO_SECRET';

export interface TrelloCredentials {
  key: string;
  token: string;
  /** The key's OAuth secret — what Trello signs webhook deliveries with; empty means no webhook, only the poll. */
  secret: string;
}

export const credentialsFile = (): string => path.join(SLOTH_HOME, 'trello.json');

function fromFile(): Partial<TrelloCredentials> {
  try {
    const raw = JSON.parse(fs.readFileSync(credentialsFile(), 'utf8')) as Partial<TrelloCredentials>;
    return { key: String(raw.key ?? ''), token: String(raw.token ?? ''), secret: String(raw.secret ?? '') };
  } catch {
    return {};
  }
}

const fromEnv = (name: string): string => envValue(name)?.trim() ?? '';

/** The credentials in force: each field from the environment first, then the file. */
export function trelloCredentials(): TrelloCredentials {
  const file = fromFile();
  return {
    key: fromEnv(TRELLO_KEY) || file.key || '',
    token: fromEnv(TRELLO_TOKEN) || file.token || '',
    secret: fromEnv(TRELLO_SECRET) || file.secret || '',
  };
}

export const trelloReady = (): boolean => {
  const c = trelloCredentials();
  return !!c.key && !!c.token;
};

/** Saved owner-readable only; a blank secret is kept blank — the webhook simply stays off. */
export function saveTrelloCredentials(c: TrelloCredentials): void {
  writeAtomic(credentialsFile(), `${JSON.stringify({ key: c.key.trim(), token: c.token.trim(), secret: c.secret.trim() }, null, 2)}\n`, { mode: 0o600 });
}

export function forgetTrelloCredentials(): void {
  fs.rmSync(credentialsFile(), { force: true });
}

/** What a page may know: whether a key and token are in force, whether a secret is, and where they came from. */
export interface TrelloInfo {
  configured: boolean;
  secret: boolean;
  source: 'env' | 'file' | 'none';
}
export function trelloInfo(): TrelloInfo {
  const c = trelloCredentials();
  const source: TrelloInfo['source'] = !c.key || !c.token ? 'none' : fromEnv(TRELLO_KEY) && fromEnv(TRELLO_TOKEN) ? 'env' : 'file';
  return { configured: source !== 'none', secret: !!c.secret, source };
}
