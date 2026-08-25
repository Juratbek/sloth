import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ColumnRef, SlothConfig } from './types';

const home = os.homedir();

/** `~/x` → `$HOME/x`; everything else resolved against the process cwd. */
export const expandPath = (p: string) => (p === '~' ? home : p.startsWith('~/') ? path.join(home, p.slice(2)) : path.resolve(p));

export const DEFAULT_CONFIG_PATH = '~/.sloth/config.json';

export function readConfigFile(file: string): SlothConfig | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as SlothConfig;
  } catch {
    return undefined;
  }
}

export function writeConfigFile(file: string, config: SlothConfig): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
}

const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${what} is required`);
  return v.trim();
};
const int = (v: unknown, fallback: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : fallback);

function column(v: unknown, what: string): ColumnRef {
  const c = v as ColumnRef | undefined;
  return { id: str(c?.id, `${what}.id`), name: str(c?.name, `${what}.name`) };
}

/** Validates a POST /api/setup/config body into a config we are willing to persist. */
export function normalizeConfig(input: unknown): SlothConfig {
  const b = (input ?? {}) as Record<string, any>;
  const columns = (b.statusField?.columns ?? {}) as Record<string, unknown>;
  return {
    version: 1,
    repo: str(b.repo, 'repo'),
    project: {
      id: str(b.project?.id, 'project.id'),
      number: int(b.project?.number, 0),
      owner: str(b.project?.owner, 'project.owner'),
      title: str(b.project?.title, 'project.title'),
    },
    statusField: {
      id: str(b.statusField?.id, 'statusField.id'),
      columns: {
        pickup: column(columns.pickup, 'pickup'),
        inProgress: column(columns.inProgress, 'inProgress'),
        needsHelp: columns.needsHelp ? column(columns.needsHelp, 'needsHelp') : null,
        codeReview: column(columns.codeReview, 'codeReview'),
      },
    },
    runnerRoot: expandPath(str(b.runnerRoot, 'runnerRoot')),
    sessionsDir: typeof b.sessionsDir === 'string' && b.sessionsDir ? b.sessionsDir : '~/.sloth/sessions',
    stateDir: typeof b.stateDir === 'string' && b.stateDir ? b.stateDir : '~/.sloth/state',
    watcherLog: typeof b.watcherLog === 'string' && b.watcherLog ? b.watcherLog : '~/.sloth/watcher.log',
    maxActive: int(b.maxActive, 3),
    maxAlive: int(b.maxAlive, 5),
    tickSeconds: int(b.tickSeconds, 300),
    tickCommand: Array.isArray(b.tickCommand) && b.tickCommand.length ? b.tickCommand.map(String) : null,
    model: typeof b.model === 'string' && b.model ? b.model : 'opus',
  };
}
