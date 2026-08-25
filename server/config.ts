import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const home = os.homedir();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Minimal KEY=value reader for the repo's .env — process env always wins. */
function readEnvFile(): Record<string, string> {
  const out: Record<string, string> = {};
  let text = '';
  try {
    text = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
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

const expand = (p: string) => (p.startsWith('~/') ? path.join(home, p.slice(2)) : path.resolve(p));
const pathOf = (key: string, fallback: string) => expand(envValue(key) ?? fallback);
function json<T>(key: string, fallback: T): T {
  const raw = envValue(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export const REPO = envValue('SLOTH_REPO') ?? '';
export const RUNNER_ROOT = pathOf('SLOTH_RUNNER_ROOT', process.cwd());
// Claude Code stores transcripts under ~/.claude/projects/<cwd with every non-alphanumeric char replaced by '-'>
export const TRANSCRIPTS_DIR = pathOf(
  'SLOTH_TRANSCRIPTS_DIR',
  path.join(home, '.claude/projects', RUNNER_ROOT.replace(/[^a-zA-Z0-9]/g, '-')),
);
export const SESSIONS_DIR = pathOf('SLOTH_SESSIONS_DIR', path.join(home, 'bot-sessions'));
export const STATE_DIR = pathOf('SLOTH_STATE_DIR', path.join(home, '.bot-state'));
export const WATCHER_LOG = pathOf('SLOTH_WATCHER_LOG', path.join(home, 'bot-watcher.log'));
export const PLIST = envValue('SLOTH_PLIST') ? expand(envValue('SLOTH_PLIST')!) : undefined;

/** Slash command → GitHub path segment for its target's link. Also drives session-kind detection. */
export const COMMANDS = json<Record<string, string>>('SLOTH_COMMANDS', {
  implement: 'issues',
  review: 'pull',
  'issue-status': 'issues',
});
/** argv for the "run the watcher now" button; no shell. Unset ⇒ the button and /api/tick are gone. */
export const TICK_COMMAND = json<string[] | undefined>('SLOTH_TICK_COMMAND', undefined);
export const TICK_SECONDS = Number(envValue('SLOTH_TICK_SECONDS') ?? 300);
export const TITLE = envValue('SLOTH_TITLE') ?? 'Sloth';
export const PORT = Number(envValue('SLOTH_PORT') ?? 4400);
