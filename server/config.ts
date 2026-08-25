import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG_PATH, expandPath, readConfigFile } from './config-file';
import type { SlothConfig } from './types';

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

export const CONFIG_PATH = expandPath(envValue('SLOTH_CONFIG') ?? DEFAULT_CONFIG_PATH);

const pathOf = (key: string, fallback: string) => expandPath(envValue(key) ?? fallback);
function json<T>(key: string, fallback: T): T {
  const raw = envValue(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Caps / pickup column / model can also live in the watcher's launchd plist (legacy setups). */
function plistValue(plist: string | undefined, key: string): string | undefined {
  if (!plist) return undefined;
  let text = '';
  try {
    text = fs.readFileSync(plist, 'utf8');
  } catch {
    return undefined;
  }
  return new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(text)?.[1];
}

export interface ResolvedConfig {
  saved?: SlothConfig;
  repo: string;
  title: string;
  runnerRoot: string;
  transcriptsDir: string;
  sessionsDir: string;
  stateDir: string;
  watcherLog: string;
  commands: Record<string, string>;
  tickCommand?: string[];
  tickSeconds: number;
  port: number;
  pickupColumn: string;
  maxActive: number;
  maxAlive: number;
  model: string;
}

/** Resolution order for every value: SLOTH_* env / .env override → saved config file → plist → default. */
function resolve(): ResolvedConfig {
  const saved = readConfigFile(CONFIG_PATH);
  const plist = envValue('SLOTH_PLIST') ? expandPath(envValue('SLOTH_PLIST')!) : undefined;
  const fromPlist = (key: string) => plistValue(plist, key);
  const repo = envValue('SLOTH_REPO') ?? saved?.repo ?? '';
  const runnerRoot = pathOf('SLOTH_RUNNER_ROOT', saved?.runnerRoot ?? process.cwd());
  const num = (key: string, fromFile: number | undefined, fallback: number) =>
    Number(envValue(key) ?? fromFile ?? fromPlist(key) ?? fallback);
  return {
    saved,
    repo,
    title: envValue('SLOTH_TITLE') ?? (repo ? `Sloth · ${repo.split('/').pop()}` : 'Sloth'),
    runnerRoot,
    // Claude Code stores transcripts under ~/.claude/projects/<cwd with every non-alphanumeric char replaced by '-'>
    transcriptsDir: pathOf(
      'SLOTH_TRANSCRIPTS_DIR',
      path.join(home, '.claude/projects', runnerRoot.replace(/[^a-zA-Z0-9]/g, '-')),
    ),
    sessionsDir: pathOf('SLOTH_SESSIONS_DIR', saved?.sessionsDir ?? '~/.sloth/sessions'),
    stateDir: pathOf('SLOTH_STATE_DIR', saved?.stateDir ?? '~/.sloth/state'),
    watcherLog: pathOf('SLOTH_WATCHER_LOG', saved?.watcherLog ?? '~/.sloth/watcher.log'),
    commands: json<Record<string, string>>('SLOTH_COMMANDS', {
      implement: 'issues',
      review: 'pull',
      'issue-status': 'issues',
    }),
    tickCommand: json<string[] | undefined>('SLOTH_TICK_COMMAND', saved?.tickCommand ?? undefined),
    tickSeconds: Number(envValue('SLOTH_TICK_SECONDS') ?? saved?.tickSeconds ?? 300),
    port: Number(envValue('SLOTH_PORT') ?? 4400),
    pickupColumn: envValue('PICKUP_COLUMN') ?? saved?.statusField.columns.pickup.name ?? fromPlist('PICKUP_COLUMN') ?? 'Todo',
    maxActive: num('MAX_ACTIVE', saved?.maxActive, 10),
    maxAlive: num('MAX_ALIVE', saved?.maxAlive, 15),
    model: envValue('MODEL') ?? saved?.model ?? fromPlist('MODEL') ?? 'opus',
  };
}

let cached: ResolvedConfig | undefined;
/** The resolved configuration; cached until the wizard saves a new config file. */
export const cfg = (): ResolvedConfig => (cached ??= resolve());
export const reloadConfig = () => {
  cached = undefined;
  return cfg();
};
