import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_TUNNEL, type ColumnRef, type SlothConfig } from './config-types';

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

/** GitHub logins from a list or a comma / space separated string; a leading `@` is dropped. */
export function logins(v: unknown): string[] {
  const raw = Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(/[\s,]+/) : [];
  return [...new Set(raw.map((l) => l.trim().replace(/^@/, '')).filter(Boolean))];
}

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
/** `owner/repo`, constrained to the characters GitHub allows — it flows into shell argv, URLs and the page title. */
function repoSlug(v: unknown): string {
  const r = str(v, 'repo');
  if (!REPO_RE.test(r)) throw new Error('repo must be owner/repo');
  return r;
}

function url(v: unknown, what: string): string {
  const u = text(v) ?? '';
  if (u && !/^https?:\/\/\S+$/.test(u)) throw new Error(`${what} must be an http(s) URL`);
  return u.replace(/\/+$/, '');
}

const argv = (v: unknown, fallback: string[]): string[] =>
  Array.isArray(v) && v.length ? v.map(String).filter((a) => a.trim()) : fallback;

function column(v: unknown, what: string): ColumnRef {
  const c = v as ColumnRef | undefined;
  return { id: str(c?.id, `${what}.id`), name: str(c?.name, `${what}.name`) };
}
/** An optional role: absent, or saved as the blank it normalizes to, both mean "no such column". */
const optional = (v: unknown, what: string): ColumnRef => ((v as ColumnRef | undefined)?.id ? column(v, what) : { id: '', name: '' });

/**
 * Validates a config payload (a POST /api/setup/config body or the saved file) into a config we are
 * willing to persist. Everything the wizard does not ask about gets its default here, so a config
 * file written by an older Sloth still loads.
 */
export function normalizeConfig(input: unknown): SlothConfig {
  const b = (input ?? {}) as Record<string, any>;
  const repo = repoSlug(b.repo);
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
        needsHelp: optional(columns.needsHelp, 'needsHelp'),
        codeReview: column(columns.codeReview, 'codeReview'),
        // Optional: without it trigger 5 (the final review of Approved cards) never fires.
        approved: optional(columns.approved, 'approved'),
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
    approvedModel: text(b.approvedModel) ?? 'fable',
    chrome: b.chrome !== false,
    helpLogins: logins(b.helpLogins),
    helpWebhook: url(b.helpWebhook, 'helpWebhook'),
    tunnel: argv(b.tunnel, DEFAULT_TUNNEL),
    publicUrl: url(b.publicUrl, 'publicUrl'),
  };
}
