import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG_PATH, expandPath, readConfigFile } from './config-file';
import { CONFIG_DEFAULTS, type SlothConfig } from './config-types';
import { clearSnapshot } from './runner/board-snapshot';

const home = os.homedir();
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

export const CONFIG_PATH = expandPath(envValue('SLOTH_CONFIG') ?? DEFAULT_CONFIG_PATH);

/** The saved config with every path made absolute, plus what only the monitor needs. */
export interface ResolvedConfig extends SlothConfig {
  configured: boolean;
  title: string;
  transcriptsDir: string;
  commands: Record<string, string>;
  port: number;
  pickupColumn: string;
}

const BLANK_COLUMN = { id: '', name: '' };
const BLANK: SlothConfig = {
  version: 1,
  repo: '',
  project: { id: '', number: 0, owner: '', title: '' },
  statusField: {
    id: '',
    columns: { pickup: BLANK_COLUMN, inProgress: BLANK_COLUMN, needsHelp: BLANK_COLUMN, codeReview: BLANK_COLUMN, approved: BLANK_COLUMN, done: BLANK_COLUMN },
  },
  runnerRoot: process.cwd(),
  worktreesDir: '~/.sloth/worktrees',
  sessionsDir: '~/.sloth/sessions',
  roles: { admin: '', developers: [], testers: [] },
  ...CONFIG_DEFAULTS,
};

/** The commands the Sloth plugin ships, mapped to the GitHub path segment of their target. */
export const COMMANDS: Record<string, string> = {
  'sloth:implement': 'issues',
  'sloth:review': 'pull',
  'sloth:status': 'issues',
};

function resolve(): ResolvedConfig {
  const saved = readConfigFile(CONFIG_PATH);
  const c = saved ?? BLANK;
  const runnerRoot = expandPath(c.runnerRoot);
  return {
    ...c,
    configured: !!saved,
    runnerRoot,
    runnersDir: expandPath(c.runnersDir),
    worktreesDir: expandPath(c.worktreesDir),
    sessionsDir: expandPath(c.sessionsDir),
    stateDir: expandPath(c.stateDir),
    watcherLog: expandPath(c.watcherLog),
    title: c.repo ? `Sloth · ${c.repo.split('/').pop()}` : 'Sloth',
    // Claude Code stores transcripts under ~/.claude/projects/<cwd with every non-alphanumeric char replaced by '-'>
    transcriptsDir: path.join(home, '.claude/projects', runnerRoot.replace(/[^a-zA-Z0-9]/g, '-')),
    commands: COMMANDS,
    port: Number(envValue('SLOTH_PORT') ?? 4400),
    pickupColumn: c.statusField.columns.pickup.name,
  };
}

let cached: ResolvedConfig | undefined;
/** The resolved configuration; cached until the wizard saves a new config file. */
export const cfg = (): ResolvedConfig => (cached ??= resolve());
export const reloadConfig = () => {
  cached = undefined;
  // The wizard may have pointed Sloth at another board; the old board's cards are not this one's.
  clearSnapshot();
  return cfg();
};
