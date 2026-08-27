import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { CONFIG_PATH, reloadConfig } from './config';
import { expandPath, normalizeConfig, readConfigFile, writeConfigFile } from './config-file';
import { watchAll } from './events';
import { ensureColumns } from './runner/columns';
import { startTunnel } from './remote';
import { startLoop } from './runner/loop';
import type { ColumnRef, ColumnRole, FieldOption, SetupCheck, SetupEnv, SetupFields, SetupProject } from './config-types';

/** execFile only — never a shell. Resolves with the command's stdout or its error text. */
function run(cmd: string, args: string[], timeout = 30_000): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) =>
    execFile(cmd, args, { timeout, maxBuffer: 8 << 20 }, (error, stdout, stderr) =>
      resolve({ ok: !error, out: String(stdout ?? '').trim(), err: (String(stderr ?? '').trim() || String(error ?? '')).trim() }),
    ),
  );
}

const firstLine = (s: string) => s.split('\n')[0].trim();
const notFound = (err: string, cmd: string) => (/ENOENT/.test(err) ? `\`${cmd}\` was not found on PATH` : err);

async function version(cmd: string): Promise<SetupCheck> {
  const r = await run(cmd, ['--version'], 20_000);
  return r.ok ? { ok: true, version: firstLine(r.out) } : { ok: false, error: notFound(r.err, cmd) };
}

async function ghAuth(): Promise<SetupCheck> {
  const status = await run('gh', ['auth', 'status'], 20_000);
  if (!status.ok) return { ok: false, error: notFound(status.err, 'gh') || 'not logged in' };
  const who = await run('gh', ['api', 'user', '--jq', '.login'], 20_000);
  return who.ok ? { ok: true, login: who.out } : { ok: false, error: who.err };
}

async function environment(): Promise<SetupEnv> {
  const [claude, gh, auth] = await Promise.all([version('claude'), version('gh'), ghAuth()]);
  return { claude, gh, ghAuth: auth };
}

async function graphql(query: string, variables: string[] = []): Promise<any> {
  const r = await run('gh', ['api', 'graphql', '-f', `query=${query}`, ...variables]);
  if (!r.ok) throw new Error(notFound(r.err, 'gh'));
  const parsed = JSON.parse(r.out);
  if (parsed.errors?.length) throw new Error(parsed.errors.map((e: { message: string }) => e.message).join('; '));
  return parsed.data;
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
async function projects(): Promise<SetupProject[]> {
  const data = await graphql(PROJECTS_QUERY);
  const orgs: RawProject[] = (data.viewer.organizations?.nodes ?? []).flatMap((o: { projectsV2?: { nodes?: RawProject[] } }) => o?.projectsV2?.nodes ?? []);
  const all: RawProject[] = [...(data.viewer.projectsV2?.nodes ?? []), ...orgs];
  const seen = new Set<string>();
  return all
    .filter((p) => p && !p.closed && !seen.has(p.id) && seen.add(p.id))
    .map((p) => ({
      id: p.id,
      number: p.number,
      title: p.title,
      url: p.url,
      owner: p.owner?.login ?? '',
      items: p.items?.totalCount ?? 0,
    }));
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

async function clone(body: any): Promise<{ ok: boolean; path?: string; error?: string }> {
  const repo = String(body?.repo ?? '');
  const target = expandPath(String(body?.path ?? ''));
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return { ok: false, error: 'repo must be owner/repo' };
  if (fs.existsSync(target)) return { ok: true, path: target };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const r = await run('gh', ['repo', 'clone', repo, target], 300_000);
  return r.ok ? { ok: true, path: target } : { ok: false, error: notFound(r.err, 'gh') };
}

const ROLES: ColumnRole[] = ['pickup', 'inProgress', 'needsHelp', 'codeReview', 'approved'];

/** Fills in the ids of columns the wizard asked Sloth to create, creating them on the board first. */
async function withColumns(body: unknown): Promise<unknown> {
  const b = (body ?? {}) as any;
  const columns = (b.statusField?.columns ?? {}) as Record<string, ColumnRef | undefined>;
  if (!b.statusField?.id || ROLES.every((role) => columns[role]?.id)) return body;
  const wanted = Object.fromEntries(
    ROLES.map((role) => [role, { id: columns[role]?.id ?? '', name: columns[role]?.name ?? '' }]),
  ) as Record<ColumnRole, ColumnRef>;
  return { ...b, statusField: { ...b.statusField, columns: await ensureColumns(b.statusField.id, wanted) } };
}

/** Routes under /api/setup/*. Returns undefined for "404" (including "no config saved yet"). */
export async function handleSetup(pathname: string, method: string, body: unknown): Promise<unknown> {
  const fields = /^\/api\/setup\/projects\/([\w-]+)\/fields$/.exec(pathname);
  if (pathname === '/api/setup/env') return environment();
  if (pathname === '/api/setup/projects') return projects();
  if (fields) return projectFields(fields[1]);
  if (pathname === '/api/setup/clone' && method === 'POST') return clone(body);
  if (pathname === '/api/setup/config' && method === 'POST') {
    const config = normalizeConfig(await withColumns(body));
    writeConfigFile(CONFIG_PATH, config);
    reloadConfig();
    watchAll();
    startLoop();
    startTunnel();
    return { ok: true, path: CONFIG_PATH, config };
  }
  if (pathname === '/api/setup/config') return readConfigFile(CONFIG_PATH);
  return undefined;
}
