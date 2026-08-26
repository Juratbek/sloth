import fs from 'node:fs';
import path from 'node:path';
import { cfg } from './config';
import { add, promptOf, readRecords, summarize, toMessages, zero } from './transcripts';
import { agentsDirOf, linkAgents, listAgents } from './agents';
import { listSessionDirs, rateLimit, titleFor, watcherInfo } from './watcher';
import type { AgentDetail, Overview, SessionDetail, SessionKind, SessionSummary, WatcherSession } from './types';

const ID = /^[\w-]+$/;
const sessionFile = (id: string) => path.join(cfg().transcriptsDir, `${id}.jsonl`);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `/<command> <number>` at the top of the prompt, where <command> is one of the configured commands. */
function classify(prompt: string): { kind: SessionKind; target?: number } {
  const names = Object.keys(cfg().commands);
  if (!names.length) return { kind: 'other' };
  const m = new RegExp(`^/(${names.map(escape).join('|')})\\s+(\\d+)`).exec(prompt);
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
    files = fs.readdirSync(cfg().transcriptsDir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return { sessions: [], orphans: listSessionDirs() };
  }
  const sessions = files.map((f) => summary(path.join(cfg().transcriptsDir, f))).sort(newestFirst);
  const orphans: WatcherSession[] = [];
  for (const dir of listSessionDirs()) {
    const wanted: SessionKind = dir.kind === 'issue' ? 'sloth:implement' : 'sloth:review';
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

export async function overview(): Promise<Overview> {
  const [rate, { sessions, orphans }] = [await rateLimit(), listSessions()];
  for (const s of sessions) if (s.target) s.title = titleFor(s.target, rate?.core?.remaining);
  return {
    generatedAt: new Date().toISOString(),
    config: monitorConfig(),
    watcher: watcherInfo(),
    rateLimit: rate,
    sessions,
    orphans,
  };
}

function monitorConfig(): Overview['config'] {
  const c = cfg();
  return {
    repo: c.repo,
    title: c.title,
    runnerRoot: c.runnerRoot,
    transcriptsDir: c.transcriptsDir,
    commands: c.commands,
    boardSeconds: c.boardSeconds,
    commentSeconds: c.commentSeconds,
    pickupColumn: c.pickupColumn,
    maxActive: c.maxActive,
    maxAlive: c.maxAlive,
    model: c.model,
  };
}

export function sessionDetail(id: string): SessionDetail | undefined {
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

export function agentDetail(id: string, agentId: string): AgentDetail | undefined {
  const file = sessionFile(id);
  if (!ID.test(id) || !ID.test(agentId) || !fs.existsSync(file)) return undefined;
  const agent = listAgents(file).find((a) => a.agentId === agentId);
  if (!agent) return undefined;
  linkAgents(readRecords(file), [agent]);
  return { ...agent, messages: toMessages(readRecords(path.join(agentsDirOf(file), `agent-${agentId}.jsonl`))) };
}
