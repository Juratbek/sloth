import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ColumnRef, SlothConfig } from './config-types';

const home = os.homedir();

/** `~/x` → `$HOME/x`; everything else resolved against the process cwd. */
export const expandPath = (p: string) => (p === '~' ? home : p.startsWith('~/') ? path.join(home, p.slice(2)) : path.resolve(p));

export const DEFAULT_CONFIG_PATH = '~/.sloth/config.json';

export function readConfigFile(file: string): SlothConfig | undefined {
  try {
    return normalizeConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
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
const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const int = (v: unknown, fallback: number, min = 1) =>
  Number.isFinite(Number(v)) && Number(v) >= min ? Math.floor(Number(v)) : fallback;

function column(v: unknown, what: string): ColumnRef {
  const c = v as ColumnRef | undefined;
  return { id: str(c?.id, `${what}.id`), name: str(c?.name, `${what}.name`) };
}

/**
 * Validates a config payload (a POST /api/setup/config body or the saved file) into a config we are
 * willing to persist. Everything the wizard does not ask about gets its default here, so a config
 * file written by an older Sloth still loads.
 */
export function normalizeConfig(input: unknown): SlothConfig {
  const b = (input ?? {}) as Record<string, any>;
  const repo = str(b.repo, 'repo');
  const name = repo.split('/')[1];
  const columns = (b.statusField?.columns ?? {}) as Record<string, unknown>;
  return {
    version: 1,
    repo,
    project: {
      id: str(b.project?.id, 'project.id'),
      number: int(b.project?.number, 0, 0),
      owner: str(b.project?.owner, 'project.owner'),
      title: str(b.project?.title, 'project.title'),
    },
    statusField: {
      id: str(b.statusField?.id, 'statusField.id'),
      columns: {
        pickup: column(columns.pickup, 'pickup'),
        inProgress: column(columns.inProgress, 'inProgress'),
        // Optional: with no needs-help column a blocked session leaves the card and marks itself blocked.
        needsHelp: columns.needsHelp ? column(columns.needsHelp, 'needsHelp') : { id: '', name: '' },
        codeReview: column(columns.codeReview, 'codeReview'),
        // Optional: without it trigger 5 (the final review of Approved cards) never fires.
        approved: columns.approved ? column(columns.approved, 'approved') : { id: '', name: '' },
      },
    },
    runnerRoot: expandPath(text(b.runnerRoot) ?? `~/.sloth/runners/${name}`),
    runnersDir: text(b.runnersDir) ?? '~/.sloth/runners',
    worktreesDir: text(b.worktreesDir) ?? `~/.sloth/worktrees/${name}`,
    sessionsDir: text(b.sessionsDir) ?? `~/.sloth/sessions/${name}`,
    stateDir: text(b.stateDir) ?? '~/.sloth/state',
    watcherLog: text(b.watcherLog) ?? '~/.sloth/watcher.log',
    orderLogin: text(b.orderLogin) ?? '',
    mention: text(b.mention) ?? '@sloth',
    botPrefix: text(b.botPrefix) ?? '**Sloth:**',
    maxActive: int(b.maxActive, 3),
    maxAlive: int(b.maxAlive, 5),
    budgetMinutes: int(b.budgetMinutes, 60),
    waitHours: int(b.waitHours, 2),
    reviewRounds: int(b.reviewRounds, 4),
    maxRetries: int(b.maxRetries, 2, 0),
    boardSeconds: int(b.boardSeconds, 300, 30),
    commentSeconds: int(b.commentSeconds, 120, 30),
    model: text(b.model) ?? 'opus',
    approvedCommand: (text(b.approvedCommand) ?? 'review').replace(/^\//, ''),
    approvedModel: text(b.approvedModel) ?? 'fable',
  };
}
