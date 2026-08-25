import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { COMMANDS, REPO, RUNNER_ROOT, TICK_COMMAND, TICK_SECONDS, TITLE, TRANSCRIPTS_DIR } from './config';
import { add, promptOf, readRecords, summarize, toMessages, zero } from './transcripts';
import { agentsDirOf, linkAgents, listAgents } from './agents';
import { listSessionDirs, rateLimit, titleFor, watcherConfig, watcherInfo } from './watcher';
import { broadcast, sse, watchAll } from './events';
import { usageSeries } from './usage';
import type { AgentDetail, Overview, SessionDetail, SessionKind, SessionSummary, WatcherSession } from './types';

const ID = /^[\w-]+$/;
const sessionFile = (id: string) => path.join(TRANSCRIPTS_DIR, `${id}.jsonl`);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const COMMAND_RE = new RegExp(`^/(${Object.keys(COMMANDS).map(escape).join('|')})\\s+(\\d+)`);

function classify(prompt: string): { kind: SessionKind; target?: number } {
  const m = Object.keys(COMMANDS).length ? COMMAND_RE.exec(prompt) : null;
  return m ? { kind: m[1], target: Number(m[2]) } : { kind: 'other' };
}

function summary(file: string): SessionSummary {
  const records = readRecords(file);
  const prompt = promptOf(records);
  const agents = listAgents(file);
  linkAgents(records, agents);
  const agentsUsage = zero();
  for (const a of agents) add(agentsUsage, a.usage);
  return {
    id: path.basename(file, '.jsonl'),
    prompt,
    ...classify(prompt),
    ...summarize(records),
    status: 'done',
    live: false,
    agents,
    agentsUsage,
  };
}

const newestFirst = (a: SessionSummary, b: SessionSummary) => (b.startedAt ?? '').localeCompare(a.startedAt ?? '');

/** Every transcript, with the watcher's session dir attached (by session_id, else newest transcript for that target). */
function listSessions(): { sessions: SessionSummary[]; orphans: WatcherSession[] } {
  let files: string[] = [];
  try {
    files = fs.readdirSync(TRANSCRIPTS_DIR).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return { sessions: [], orphans: listSessionDirs() };
  }
  const sessions = files.map((f) => summary(path.join(TRANSCRIPTS_DIR, f))).sort(newestFirst);
  const orphans: WatcherSession[] = [];
  for (const dir of listSessionDirs()) {
    const wanted: SessionKind = dir.kind === 'issue' ? 'implement' : 'review';
    const s =
      sessions.find((x) => x.id === dir.sessionId) ??
      sessions.find((x) => !x.watcher && x.kind === wanted && x.target === dir.target);
    if (!s) {
      orphans.push(dir);
      continue;
    }
    s.watcher = dir;
    s.live = dir.alive;
    const waiting = dir.state?.state === 'waiting';
    s.status = dir.alive ? (waiting ? 'waiting' : 'running') : waiting ? 'parked' : 'done';
  }
  return { sessions, orphans };
}

async function overview(): Promise<Overview> {
  const [rate, { sessions, orphans }] = [await rateLimit(), listSessions()];
  for (const s of sessions) if (s.target) s.title = titleFor(s.target, rate?.core?.remaining);
  return {
    generatedAt: new Date().toISOString(),
    config: {
      repo: REPO,
      title: TITLE,
      runnerRoot: RUNNER_ROOT,
      transcriptsDir: TRANSCRIPTS_DIR,
      commands: COMMANDS,
      tickEnabled: !!TICK_COMMAND?.length,
      tickSeconds: TICK_SECONDS,
      ...watcherConfig(),
    },
    watcher: watcherInfo(),
    rateLimit: rate,
    sessions,
    orphans,
  };
}

function sessionDetail(id: string): SessionDetail | undefined {
  const file = sessionFile(id);
  if (!ID.test(id) || !fs.existsSync(file)) return undefined;
  const s = listSessions().sessions.find((x) => x.id === id) ?? summary(file);
  const records = readRecords(file);
  const links = linkAgents(records, s.agents);
  const messages = toMessages(records);
  for (const m of messages)
    for (const b of m.blocks) if (b.type === 'tool_use' && links.has(b.id)) b.agentId = links.get(b.id);
  return { ...s, messages };
}

function agentDetail(id: string, agentId: string): AgentDetail | undefined {
  const file = sessionFile(id);
  if (!ID.test(id) || !ID.test(agentId) || !fs.existsSync(file)) return undefined;
  const agent = listAgents(file).find((a) => a.agentId === agentId);
  if (!agent) return undefined;
  linkAgents(readRecords(file), [agent]);
  return { ...agent, messages: toMessages(readRecords(path.join(agentsDirOf(file), `agent-${agentId}.jsonl`))) };
}

/** The one write endpoint: run SLOTH_TICK_COMMAND, i.e. ask the watcher to run now. */
function tick(): boolean {
  if (!TICK_COMMAND?.length) return false;
  const [cmd, ...args] = TICK_COMMAND;
  execFile(cmd, args).unref();
  return true;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const p = url.pathname;
  if (!p.startsWith('/api/')) return false;
  if (p === '/api/events') {
    sse(req, res);
    return true;
  }
  let body: unknown;
  try {
    const session = /^\/api\/sessions\/([\w-]+)$/.exec(p);
    const agent = /^\/api\/sessions\/([\w-]+)\/agents\/(\w+)$/.exec(p);
    if (p === '/api/tick' && req.method === 'POST') {
      if (tick()) {
        broadcast();
        body = { ok: true };
      }
    } else if (p === '/api/overview') body = await overview();
    else if (p === '/api/usage') body = usageSeries(Math.min(31, Number(url.searchParams.get('days')) || 7));
    else if (session) body = sessionDetail(session[1]);
    else if (agent) body = agentDetail(agent[1], agent[2]);
    if (body === undefined) {
      res.statusCode = 404;
      res.end('not found');
      return true;
    }
  } catch (e) {
    res.statusCode = 500;
    res.end(String(e));
    return true;
  }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
  return true;
}

/** Vite plugin: serves the read-only monitor API from the same process as the UI (dev and preview). */
export function monitorApi(): Plugin {
  const mount = (server: { middlewares: { use: (fn: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) => void } }) => {
    watchAll();
    server.middlewares.use((req, res, next) => {
      void handle(req, res).then((handled) => handled || next());
    });
  };
  return {
    name: 'sloth-api',
    transformIndexHtml: (html) => html.replace(/<title>[^<]*<\/title>/, `<title>${TITLE}</title>`),
    configureServer: mount,
    configurePreviewServer: mount,
  };
}
