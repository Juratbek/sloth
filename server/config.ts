import os from 'node:os';
import path from 'node:path';
import { expandPath, readConfigFile } from './config-file';
import { CONFIG_PATH, envValue } from './env';
import { CONFIG_DEFAULTS, type SlothConfig } from './config-types';
import { clearSnapshot } from './runner/board-snapshot';

export { CONFIG_PATH, PLUGIN_DIR, SLOTH_ROOT, envValue } from './env';

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
  project: { provider: 'github', id: '', number: 0, owner: '', title: '' },
  statusField: {
    id: '',
    columns: { pickup: BLANK_COLUMN, inProgress: BLANK_COLUMN, needsHelp: BLANK_COLUMN, codeReview: BLANK_COLUMN, approved: BLANK_COLUMN, qa: BLANK_COLUMN, done: BLANK_COLUMN },
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
  'sloth:qa': 'issues',
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
    transcriptsDir: path.join(os.homedir(), '.claude/projects', runnerRoot.replace(/[^a-zA-Z0-9]/g, '-')),
    commands: COMMANDS,
    // `??` lets `SLOTH_PORT=` through as an empty string, which `Number` reads as 0 and Vite binds a
    // random port for — the QR code, the launch agent and the docs then all name a port nobody is on.
    port: Number(envValue('SLOTH_PORT')?.trim() || 4400),
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
