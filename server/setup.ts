import fs from 'node:fs';
import { CONFIG_PATH, reloadConfig } from './config';
import { SLOTH_HOME_LABEL } from './env';
import { run } from './exec';
import { cancelGhLogin, ghLoginStatus, startGhLogin } from './gh-login';
import { checkoutInBackground, cloneRepo } from './checkout';
import type { CloneResult } from './checkout';
import { expandPath, normalizeConfig, readConfigFile, writeConfigFile } from './config-file';
import { watchAll } from './events';
import { ensureTrelloLists } from './runner/board-trello';
import { ensureColumns } from './runner/columns';
import * as trello from './trello';
import { trelloReady } from './trello';
import { credentialsFile, forgetTrelloCredentials, saveTrelloCredentials, trelloInfo } from './trello-credentials';
import type { TrelloCredentials, TrelloInfo } from './trello-credentials';
import { graphql as ghGraphql } from './runner/gh';
import { startTunnel } from './remote';
import { betweenTicks, startLoop } from './runner/loop';
import { applyAutostart } from './service';
import { ensureStack } from './stack';
import { log } from './runner/log';
import type { ColumnRef, ColumnRole, FieldOption, SetupCheck, SetupEnv, SetupFields, SetupProject } from './config-types';

const firstLine = (s: string) => s.split('\n')[0].trim();
const notFound = (err: string, cmd: string) => (/ENOENT/.test(err) ? `\`${cmd}\` was not found on PATH` : err);

async function version(cmd: string): Promise<SetupCheck> {
  const r = await run(cmd, ['--version'], { timeout: 20_000 });
  return r.ok ? { ok: true, version: firstLine(r.out) } : { ok: false, error: notFound(r.err, cmd) };
}

/**
 * The account `gh auth status` names — "Logged in to github.com account alice (keyring)" — read off the
 * machine's own gh config, so it is there even while the token check behind the line fails. Older gh
 * versions print the status to stderr, so both streams are read; the active account comes first.
 */
export function accountFrom(text: string): string | undefined {
  return /github\.com account (\S+)/.exec(text)?.[1];
}

async function ghAuth(): Promise<SetupCheck> {
  const status = await run('gh', ['auth', 'status'], { timeout: 20_000 });
  const login = accountFrom(`${status.out}\n${status.err}`);
  if (!status.ok) return { ok: false, error: notFound(status.err, 'gh') || 'not logged in', ...(login ? { login } : {}) };
  if (login) return { ok: true, login };
  const who = await run('gh', ['api', 'user', '--jq', '.login'], { timeout: 20_000 });
  return who.ok ? { ok: true, login: who.out } : { ok: false, error: who.err };
}

/** The Trello key and token, when both are set: who they sign in as, or why they do not. */
async function trelloAuth(): Promise<SetupCheck> {
  try {
    return { ok: true, login: (await trello.me()).username };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function environment(): Promise<SetupEnv> {
  const [claude, gh, auth, trelloCheck] = await Promise.all([version('claude'), version('gh'), ghAuth(), trelloReady() ? trelloAuth() : undefined]);
  return { home: SLOTH_HOME_LABEL, claude, gh, ghAuth: auth, ...(trelloCheck ? { trello: trelloCheck } : {}) };
}

/**
 * The runner's `graphql` — the same single retry every other GitHub call gets, because the wizard reads
 * the same flaky API. Only the wording is the wizard's: a `gh` that is not on PATH is a thing the user
 * can fix, and "ENOENT" does not say so.
 */
async function graphql(query: string, variables: string[] = []): Promise<any> {
  try {
    return await ghGraphql(query, variables);
  } catch (e) {
    throw new Error(notFound(e instanceof Error ? e.message : String(e), 'gh'));
  }
}

const PROJECT_FIELDS = `id number title closed url owner { ... on User { login } ... on Organization { login } } items { totalCount }`;
const PROJECTS_QUERY = `query {
  viewer {
    projectsV2(first: 50) { nodes { ${PROJECT_FIELDS} } }
    organizations(first: 20) { nodes { projectsV2(first: 50) { nodes { ${PROJECT_FIELDS} } } } }
  }
}`;

interface RawProject {
  id: string;
  number: number;
  title: string;
  closed: boolean;
  url: string;
  owner?: { login?: string };
  items?: { totalCount?: number };
}

/** Every open Projects (v2) board the authenticated user can pick — their own plus their orgs'. */
async function githubProjects(): Promise<SetupProject[]> {
  const data = await graphql(PROJECTS_QUERY);
  const orgs: RawProject[] = (data.viewer.organizations?.nodes ?? []).flatMap((o: { projectsV2?: { nodes?: RawProject[] } }) => o?.projectsV2?.nodes ?? []);
  const all: RawProject[] = [...(data.viewer.projectsV2?.nodes ?? []), ...orgs];
  const seen = new Set<string>();
  return all
    .filter((p) => p && !p.closed && !seen.has(p.id) && seen.add(p.id))
    .map((p) => ({
      provider: 'github' as const,
      id: p.id,
      number: p.number,
      title: p.title,
      url: p.url,
      owner: p.owner?.login ?? '',
      items: p.items?.totalCount ?? 0,
    }));
}

/** Every open Trello board the token's member is on — none without a key and token, and none when Trello will not answer. */
async function trelloBoards(): Promise<SetupProject[]> {
  if (!trelloReady()) return [];
  try {
    const [who, boards] = await Promise.all([trello.me(), trello.boards()]);
    return boards.map((b) => ({ provider: 'trello' as const, id: b.id, number: 0, title: b.name, url: b.url, owner: who.username, items: 0 }));
  } catch (e) {
    throw new Error(`Trello: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** The boards the wizard offers: GitHub's, then Trello's. */
async function projects(): Promise<SetupProject[]> {
  const [github, trelloList] = await Promise.all([githubProjects(), trelloBoards()]);
  return [...github, ...trelloList];
}

/** A Trello board id: 24 hex digits, which no Projects node id (`PVT_…`) ever is. */
const TRELLO_ID = /^[0-9a-f]{24}$/;

/** A Trello board's lists, in the shape of a Status field, so the column steps need not know the difference. */
async function trelloFields(boardId: string): Promise<SetupFields> {
  const lists = await trello.lists(boardId);
  return { statusField: { id: boardId, name: 'Lists', options: lists.map(({ id, name }) => ({ id, name })) }, repositories: [] };
}

const FIELDS_QUERY = `query($id: ID!) {
  node(id: $id) {
    ... on ProjectV2 {
      fields(first: 30) { nodes { ... on ProjectV2SingleSelectField { id name options { id name color description } } } }
      repositories(first: 20) { nodes { nameWithOwner } }
    }
  }
}`;

/** The board's Status single-select (options in board order) plus the repositories linked to it. */
async function projectFields(id: string): Promise<SetupFields> {
  const data = await graphql(FIELDS_QUERY, ['-F', `id=${id}`]);
  const nodes = (data.node?.fields?.nodes ?? []) as { id?: string; name?: string; options?: FieldOption[] }[];
  const status = nodes.find((f) => f?.options && /^status$/i.test(f.name ?? '')) ?? nodes.find((f) => f?.options);
  return {
    statusField: status?.id ? { id: status.id, name: status.name ?? 'Status', options: status.options ?? [] } : undefined,
    repositories: ((data.node?.repositories?.nodes ?? []) as { nameWithOwner: string }[]).map((r) => r.nameWithOwner),
  };
}

/** The Settings button: the same clone the boot and the tick make on their own, shared with one in flight. */
function clone(body: any): Promise<CloneResult> {
  const target = String(body?.path ?? '').trim();
  if (!target) return Promise.resolve({ ok: false, error: 'a path to clone into is needed' });
  return cloneRepo(String(body?.repo ?? ''), expandPath(target));
}

/**
 * The checkout, then the stack: a stack set to `auto` is read off the checkout's files, so it is judged
 * only once they are there. Neither the boot nor a config save waits on either; the health chip says
 * "cloning" meanwhile.
 */
export function checkoutThenStack(): void {
  void checkoutInBackground()
    .then(() => ensureStack())
    .catch((e) => log(`stack: ${(e instanceof Error ? e.message : String(e)).split('\n')[0]}`));
}

const ROLES: ColumnRole[] = ['pickup', 'inProgress', 'needsHelp', 'codeReview', 'approved', 'qa', 'done'];

/** Fills in the ids of columns the wizard asked Sloth to create, creating them on the board first. */
async function withColumns(body: unknown): Promise<unknown> {
  const b = (body ?? {}) as any;
  const columns = (b.statusField?.columns ?? {}) as Record<string, ColumnRef | undefined>;
  // QA is opt-in: left blank it is not a column to create, so nothing is missing on its account.
  const settled = (role: ColumnRole) => !!columns[role]?.id || (role === 'qa' && !columns.qa?.name);
  if (!b.statusField?.id || ROLES.every(settled)) return body;
  const wanted = Object.fromEntries(
    ROLES.map((role) => [role, { id: columns[role]?.id ?? '', name: columns[role]?.name ?? '' }]),
  ) as Record<ColumnRole, ColumnRef>;
  const ensure = b.project?.provider === 'trello' ? ensureTrelloLists : ensureColumns;
  return { ...b, statusField: { ...b.statusField, columns: await ensure(b.statusField.id, wanted) } };
}

/**
 * The Trello key, token and secret, typed into the wizard or Settings: tried against Trello first, saved
 * only when they open an account, and never echoed back. A blank key and token forget what was saved.
 */
async function connectTrello(body: unknown): Promise<TrelloInfo & { username?: string; error?: string }> {
  const b = (body ?? {}) as Partial<TrelloCredentials>;
  const creds = { key: String(b.key ?? '').trim(), token: String(b.token ?? '').trim(), secret: String(b.secret ?? '').trim() };
  if (!creds.key && !creds.token) {
    forgetTrelloCredentials();
    return trelloInfo();
  }
  if (!creds.key || !creds.token) return { ...trelloInfo(), error: 'both the API key and the token are needed' };
  const before = fs.existsSync(credentialsFile()) ? fs.readFileSync(credentialsFile(), 'utf8') : undefined;
  saveTrelloCredentials(creds);
  try {
    const who = await trello.me();
    return { ...trelloInfo(), username: who.username };
  } catch (e) {
    if (before === undefined) forgetTrelloCredentials();
    else fs.writeFileSync(credentialsFile(), before, { mode: 0o600 });
    return { ...trelloInfo(), error: `Trello did not accept them: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Routes under /api/setup/*. Returns undefined for "404" (including "no config saved yet"). */
export async function handleSetup(pathname: string, method: string, body: unknown): Promise<unknown> {
  const fields = /^\/api\/setup\/projects\/([\w-]+)\/fields$/.exec(pathname);
  if (pathname === '/api/setup/env') return environment();
  if (pathname === '/api/setup/gh-login') return method === 'POST' ? startGhLogin() : ghLoginStatus();
  if (pathname === '/api/setup/gh-login/cancel' && method === 'POST') return cancelGhLogin();
  if (pathname === '/api/setup/trello') return method === 'POST' ? connectTrello(body) : trelloInfo();
  if (pathname === '/api/setup/projects') return projects();
  if (fields) return TRELLO_ID.test(fields[1]) ? trelloFields(fields[1]) : projectFields(fields[1]);
  if (pathname === '/api/setup/clone' && method === 'POST') return clone(body);
  if (pathname === '/api/setup/config' && method === 'POST') {
    const was = readConfigFile(CONFIG_PATH)?.autostart ?? false;
    const config = normalizeConfig(await withColumns(body));
    // The new config lands between two ticks, never inside one — see `betweenTicks`. The board tick the
    // save waits for is the old board's last, and the timers this arms are the new board's first.
    await betweenTicks(() => {
      writeConfigFile(CONFIG_PATH, config);
      reloadConfig();
      watchAll();
      startLoop();
      startTunnel();
    });
    // The checkout the sessions need is Sloth's to make: cloned now if the saved root is not one yet.
    checkoutThenStack();
    // The launch agent is named after the repo and points at this checkout, so it is written from here.
    const serviceError = config.autostart === was ? undefined : await applyAutostart(config.autostart);
    return { ok: true, path: CONFIG_PATH, config, serviceError };
  }
  if (pathname === '/api/setup/config') return readConfigFile(CONFIG_PATH);
  return undefined;
}
