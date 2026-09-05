import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where this Sloth lives. One config file per instance (`SLOTH_CONFIG`, `~/.sloth/config.json` by
 * default), and everything the instance owns — its state, sessions, worktrees, runners, log, Trello
 * credentials — defaults to the directory that file is in. Two Sloths on one machine, two config files,
 * two homes: neither ever reads the other's sessions or answers on the other's cards.
 */

/** The Sloth checkout itself — where `plugin/` lives. */
export const SLOTH_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PLUGIN_DIR = path.join(SLOTH_ROOT, 'plugin');

/** Minimal KEY=value reader for the repo's .env — process env always wins. */
function readEnvFile(): Record<string, string> {
  const out: Record<string, string> = {};
  let text = '';
  try {
    text = fs.readFileSync(path.join(SLOTH_ROOT, '.env'), 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || line.trimStart().startsWith('#')) continue;
    out[m[1]] = m[2].trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
  }
  return out;
}

const file = readEnvFile();
/** One config value: process env, then .env, then undefined. */
export const envValue = (key: string): string | undefined => process.env[key] ?? file[key];

const home = os.homedir();
/** `~/x` → `$HOME/x`; everything else resolved against the process cwd. */
export const expandPath = (p: string) => (p === '~' ? home : p.startsWith('~/') ? path.join(home, p.slice(2)) : path.resolve(p));

export const DEFAULT_CONFIG_PATH = '~/.sloth/config.json';
export const CONFIG_PATH = expandPath(envValue('SLOTH_CONFIG') ?? DEFAULT_CONFIG_PATH);

/** The instance's home: the directory its config file is in. */
export const SLOTH_HOME = path.dirname(CONFIG_PATH);
/** The same, as it is written into a config: `~/.sloth` for the default home, so a file reads as it always has. */
export const SLOTH_HOME_LABEL = SLOTH_HOME === path.join(home, '.sloth') ? '~/.sloth' : SLOTH_HOME;
