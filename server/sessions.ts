import fs from 'node:fs';
import path from 'node:path';
import { cfg } from './config';
import { add, promptOf, readRecords, summarize, toMessages, zero } from './transcripts';
import { agentsDirOf, linkAgents, listAgents } from './agents';
import { costOfUsage } from './pricing';
import { rollup } from './issue-costs';
import { boardFromSnapshot } from './board-view';
import { remoteStatus } from './remote';
import { listSessionDirs, rateLimit, titleFor, watcherInfo } from './watcher';
import type { AgentDetail, AgentSummary, ModelUsage, Overview, SessionDetail, SessionKind, SessionSummary, WatcherSession } from './types';

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

/**
 * What a run would have cost on API billing, its subagents included. One model with no list price makes
 * the whole run unpriced rather than cheap: a number missing a third of the spend is worse than none.
 * Rows with no tokens at all (`<synthetic>`) are not models anyone was billed for.
 */
function costOfRun(byModel: ModelUsage[], agents: AgentSummary[]): number | null {
  let total = 0;
  for (const m of [...byModel, ...agents.flatMap((a) => a.byModel)]) {
    if (m.input + m.output + m.cacheRead + m.cacheWrite === 0) continue;
    const c = costOfUsage(m.model, m);
    if (c === undefined) return null;
    total += c;
  }
  return total;
}

function summary(file: string): SessionSummary {
  const records = readRecords(file);
  const prompt = promptOf(records);
  const agents = listAgents(file);
  linkAgents(records, agents);
  const agentsUsage = zero();
  for (const a of agents) add(agentsUsage, a.usage);
  const stats = summarize(records);
  return {
    id: path.basename(file, '.jsonl'),
    prompt,
    ...classify(prompt),
    ...stats,
    status: 'done',
    live: false,
    agents,
    agentsUsage,
    cost: costOfRun(stats.byModel, agents),
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
    const wanted: SessionKind = dir.kind === 'issue' ? 'sloth:implement' : dir.kind === 'qa' ? 'sloth:qa' : 'sloth:review';
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
  const issues = rollup(sessions, (n) => titleFor(n, rate?.core?.remaining));
  return {
    generatedAt: new Date().toISOString(),
    config: monitorConfig(),
    remote: remoteStatus(),
    watcher: watcherInfo(),
    rateLimit: rate,
    sessions,
    orphans,
    issues,
    board: boardFromSnapshot(sessions, issues),
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
    models: c.models,
    qaColumn: c.statusField.columns.qa.name,
    qaAt: c.qa.at,
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

/** The session directory a transcript is linked to — what a stop acts on. */
export function watcherOf(id: string): WatcherSession | undefined {
  if (!ID.test(id) || !fs.existsSync(sessionFile(id))) return undefined;
  return listSessions().sessions.find((x) => x.id === id)?.watcher;
}

export function agentDetail(id: string, agentId: string): AgentDetail | undefined {
  const file = sessionFile(id);
  if (!ID.test(id) || !ID.test(agentId) || !fs.existsSync(file)) return undefined;
  const agent = listAgents(file).find((a) => a.agentId === agentId);
  if (!agent) return undefined;
  linkAgents(readRecords(file), [agent]);
  return { ...agent, messages: toMessages(readRecords(path.join(agentsDirOf(file), `agent-${agentId}.jsonl`))) };
}
