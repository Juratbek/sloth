import os from 'node:os';
import path from 'node:path';
import { expandPath, readConfigFile } from './config-file';
import { CONFIG_PATH, envValue } from './env';
import { CONFIG_DEFAULTS, type SlothConfig } from './config-types';
import { repoName, type RepoConfig } from './repo-types';
import { clearSnapshot } from './runner/board-snapshot';

export { CONFIG_PATH, PLUGIN_DIR, SLOTH_ROOT, envValue } from './env';

/** The saved config with every path made absolute, plus what only the monitor needs. */
export interface ResolvedConfig extends SlothConfig {
  configured: boolean;
  title: string;
  /** The first repository's transcripts — every repository has a directory of its own (`transcriptsDirOf`). */
  transcriptsDir: string;
  commands: Record<string, string>;
  port: number;
  pickupColumn: string;
}

/** Claude Code stores transcripts under ~/.claude/projects/<cwd with every non-alphanumeric char replaced by '-'>. */
export const transcriptsDirOf = (root: string): string => path.join(os.homedir(), '.claude/projects', root.replace(/[^a-zA-Z0-9]/g, '-'));

/** The page title: the repositories by name, three at most, then a count. */
export function titleOf(repos: RepoConfig[]): string {
  const names = repos.map((r) => repoName(r.slug));
  if (!names.length) return 'Sloth';
  const shown = names.slice(0, 3).join(' · ');
  return `Sloth · ${shown}${names.length > 3 ? ` +${names.length - 3}` : ''}`;
}

const BLANK_COLUMN = { id: '', name: '' };
const BLANK: SlothConfig = {
  version: 1,
  repos: [],
  legacyRepo: '',
  project: { provider: 'github', id: '', number: 0, owner: '', title: '' },
  statusField: {
    id: '',
    columns: { pickup: BLANK_COLUMN, inProgress: BLANK_COLUMN, needsHelp: BLANK_COLUMN, codeReview: BLANK_COLUMN, approved: BLANK_COLUMN, qa: BLANK_COLUMN, done: BLANK_COLUMN },
  },
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
  // A smoke test's number is a run's, not an issue's: nothing on GitHub to link it to.
  'sloth:smoke': '',
};

function resolve(): ResolvedConfig {
  const saved = readConfigFile(CONFIG_PATH);
  const c = saved ?? BLANK;
  const repos = c.repos.map((r) => ({ ...r, root: expandPath(r.root) }));
  return {
    ...c,
    repos,
    configured: !!saved,
    runnersDir: expandPath(c.runnersDir),
    worktreesDir: expandPath(c.worktreesDir),
    sessionsDir: expandPath(c.sessionsDir),
    stateDir: expandPath(c.stateDir),
    watcherLog: expandPath(c.watcherLog),
    title: titleOf(repos),
    transcriptsDir: transcriptsDirOf(repos[0]?.root ?? process.cwd()),
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
