import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AGENT_ROLES, CONFIG_DEFAULTS, DEFAULT_MODELS, MERGE_METHODS, STACK, WEBHOOK_EVENTS, defaultDirs, type AgentModels, type AgentRole, type ColumnRef, type MergeMethod, type Roles, type SlothConfig, type StackChoice, type StackId, type WebhookEvent } from './config-types';
import { sameLogin } from './roles';

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

/**
 * The team. A login appears in one role only: the admin is dropped from the other lists and a
 * developer from the testers. `orderLogin` is what a config from before roles called the admin.
 */
function roles(v: unknown, orderLogin: unknown): Roles {
  const r = (v ?? {}) as Record<string, unknown>;
  const admin = (text(r.admin) ?? text(orderLogin) ?? '').replace(/^@/, '');
  // Keeps the first spelling of every login and drops the rest, across the lists and within one.
  const seen = [admin];
  const fresh = (login: string) => !seen.some((t) => sameLogin(t, login)) && !!seen.push(login);
  const developers = logins(r.developers).filter(fresh);
  const testers = logins(r.testers).filter(fresh);
  return { admin, developers, testers };
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

/** A Claude Code `--model` value: an alias or a model id — one word, it goes straight into argv. */
function model(v: unknown, what: string): string | undefined {
  const m = text(v);
  if (m && /\s/.test(m)) throw new Error(`${what} must be a single model name or id`);
  return m;
}

/**
 * One model per agent. A config from before per-agent models had `model` for every session and
 * `approvedModel` for the final review; those still load as they used to run.
 */
function models(v: unknown, legacyModel: unknown, legacyApproved: unknown): AgentModels {
  const m = (v ?? {}) as Record<string, unknown>;
  const every = model(legacyModel, 'model');
  const pick = (role: AgentRole) =>
    model(m[role], `models.${role}`) ?? (role === 'final' ? model(legacyApproved, 'approvedModel') : every) ?? DEFAULT_MODELS[role];
  return Object.fromEntries(AGENT_ROLES.map((role) => [role, pick(role)])) as unknown as AgentModels;
}

/** One of the `gh pr merge` methods, or empty for "a human merges". Anything else is rejected — it goes into argv. */
function mergeMethod(v: unknown): MergeMethod {
  const m = text(v) ?? '';
  if (!MERGE_METHODS.includes(m as MergeMethod)) throw new Error(`autoMerge must be one of ${MERGE_METHODS.filter(Boolean).join(', ')} or empty`);
  return m as MergeMethod;
}

/** The events a saved config asks for; anything unknown is dropped, and an explicit empty list is kept. */
function webhookEvents(v: unknown, fallback: WebhookEvent[]): WebhookEvent[] {
  if (!Array.isArray(v)) return fallback;
  const known = WEBHOOK_EVENTS as readonly string[];
  return [...new Set(v.map(String).filter((e): e is WebhookEvent => known.includes(e)))];
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
  const d = CONFIG_DEFAULTS;
  const dirs = defaultDirs(name);
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
        // Optional: without it a closed issue's card stays where it is (trigger 6).
        done: optional(columns.done, 'done'),
      },
    },
    runnerRoot: expandPath(text(b.runnerRoot) ?? dirs.runnerRoot),
    runnersDir: text(b.runnersDir) ?? d.runnersDir,
    worktreesDir: text(b.worktreesDir) ?? dirs.worktreesDir,
    sessionsDir: text(b.sessionsDir) ?? dirs.sessionsDir,
    stateDir: text(b.stateDir) ?? d.stateDir,
    watcherLog: text(b.watcherLog) ?? d.watcherLog,
    roles: roles(b.roles, b.orderLogin),
    mention: text(b.mention) ?? d.mention,
    botPrefix: text(b.botPrefix) ?? d.botPrefix,
    maxActive: int(b.maxActive, d.maxActive),
    maxAlive: int(b.maxAlive, d.maxAlive),
    budgetMinutes: int(b.budgetMinutes, d.budgetMinutes),
    waitHours: int(b.waitHours, d.waitHours),
    reviewRounds: int(b.reviewRounds, d.reviewRounds),
    maxRetries: int(b.maxRetries, d.maxRetries, 0),
    boardSeconds: int(b.boardSeconds, d.boardSeconds, 30),
    commentSeconds: int(b.commentSeconds, d.commentSeconds, 30),
    models: models(b.models, b.model, b.approvedModel),
    chrome: b.chrome !== false,
    autostart: b.autostart === true,
    previewHours: int(b.previewHours, d.previewHours, 0),
    keepDays: int(b.keepDays, d.keepDays),
    // An explicit "" turns the ranking off, so it has to survive: `text` would hand back the default.
    priorityField: typeof b.priorityField === 'string' ? b.priorityField.trim() : d.priorityField,
    helpLogins: logins(b.helpLogins),
    helpWebhook: url(b.helpWebhook, 'helpWebhook'),
    webhookEvents: webhookEvents(b.webhookEvents, d.webhookEvents),
    autoMerge: mergeMethod(b.autoMerge),
    tunnel: argv(b.tunnel, d.tunnel),
    publicUrl: url(b.publicUrl, 'publicUrl'),
    stack: stackOf(b.stack),
  };
}

/** The stack choice: `auto` unless a list is given; a list keeps only the ids Sloth can install, once each. */
export function stackOf(v: unknown): StackChoice {
  if (!Array.isArray(v)) return 'auto';
  const ids = v.map((x) => String(x).trim().toLowerCase()).filter((x): x is StackId => (STACK as readonly string[]).includes(x));
  return [...new Set(ids)];
}
