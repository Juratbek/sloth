import fs from 'node:fs';
import path from 'node:path';
import { cfg } from './config';
import { add, digestFile, promptFrom, readRecords, statsOf, toMessages, zero } from './transcripts';
import { agentsDirOf, applyLinks, linkAgents, listAgents } from './agents';
import { costOfUsage } from './pricing';
import { rollup } from './issue-costs';
import { boardFromSnapshot, type HoldState } from './board-view';
import { primaryRepo, repoOfTranscriptsDir, repos, transcriptFile, transcriptsDirs } from './repos';
import { blockedCards } from './runner/blocked';
import { machineHold } from './runner/machine';
import { isPaused } from './runner/pause';
import { pausedUntil } from './runner/run-control';
import { slotsFull } from './runner/session-dirs';
import { remoteStatus } from './remote';
import { listSessionDirs, rateLimit, titleFor, watcherInfo } from './watcher';
import type { AgentDetail, AgentSummary, ModelUsage, Overview, SessionDetail, SessionKind, SessionSummary, WatcherSession } from './types';

const ID = /^[\w-]+$/;
/** The transcript of a session, in whichever repository's directory it landed. */
const sessionFile = (id: string) => transcriptFile(id);

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

/** One transcript's row in the list, out of its digest — the records themselves are never held for this. `repo` is the one whose checkout it ran in. */
function summary(file: string, repo = repoOfTranscriptsDir(path.dirname(file)) ?? primaryRepo()): SessionSummary {
  const d = digestFile(file);
  const prompt = promptFrom(d);
  const agents = listAgents(file);
  applyLinks(d, agents);
  const agentsUsage = zero();
  for (const a of agents) add(agentsUsage, a.usage);
  const stats = statsOf(d);
  return {
    id: path.basename(file, '.jsonl'),
    prompt,
    ...classify(prompt),
    repo,
    ...stats,
    status: 'done',
    live: false,
    agents,
    agentsUsage,
    cost: costOfRun(stats.byModel, agents),
  };
}

const newestFirst = (a: SessionSummary, b: SessionSummary) => (b.startedAt ?? '').localeCompare(a.startedAt ?? '');

/**
 * Every transcript of every repository — each one's sessions land under its own checkout — with the
 * watcher's session dir attached (by session_id, else the newest transcript for that target in that repository).
 */
function listSessions(): { sessions: SessionSummary[]; orphans: WatcherSession[] } {
  const sessions: SessionSummary[] = [];
  for (const dir of transcriptsDirs()) {
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) sessions.push(summary(path.join(dir, f)));
  }
  sessions.sort(newestFirst);
  const orphans: WatcherSession[] = [];
  for (const dir of listSessionDirs()) {
    const wanted: SessionKind = dir.kind === 'issue' ? 'sloth:implement' : dir.kind === 'qa' ? 'sloth:qa' : dir.kind === 'smoke' ? 'sloth:smoke' : 'sloth:review';
    const s =
      sessions.find((x) => x.id === dir.sessionId) ??
      sessions.find((x) => !x.watcher && x.kind === wanted && x.target === dir.target && x.repo === dir.repo);
    if (!s) {
      orphans.push(dir);
      continue;
    }
    s.watcher = dir;
    s.repo = dir.repo;
    s.live = dir.alive;
    const waiting = dir.state?.state === 'waiting';
    s.status = dir.alive ? (waiting ? 'waiting' : 'running') : waiting ? 'parked' : 'done';
  }
  return { sessions, orphans };
}

/**
 * Why the loop is starting nothing just now, for the board's per-card hold lines. Read here rather than
 * inside `board-view.ts` so the join itself stays a pure function of what it is given: these four are
 * live state — a pause file, the last machine reading, the session directories on disk.
 */
const holdState = (): HoldState => ({
  paused: isPaused(),
  pausedUntil: pausedUntil(),
  machine: machineHold(),
  slotsFull: slotsFull(),
  maxRetries: cfg().maxRetries,
});

export async function overview(): Promise<Overview> {
  const [rate, { sessions, orphans }] = [await rateLimit(), listSessions()];
  // A smoke test's number is its own, not an issue's: no title to look up, and none to mistake.
  for (const s of sessions) if (s.target && s.kind !== 'sloth:smoke') s.title = titleFor({ repo: s.repo, number: s.target }, rate?.core?.remaining);
  const issues = rollup(sessions, (ref) => titleFor(ref, rate?.core?.remaining));
  return {
    generatedAt: new Date().toISOString(),
    config: monitorConfig(),
    remote: remoteStatus(),
    watcher: watcherInfo(),
    rateLimit: rate,
    sessions,
    orphans,
    issues,
    board: boardFromSnapshot(sessions, issues, holdState()),
    blocked: blockedCards(),
  };
}

function monitorConfig(): Overview['config'] {
  const c = cfg();
  return {
    repo: primaryRepo(),
    repos: repos(),
    title: c.title,
    runnerRoot: c.repos[0]?.root ?? '',
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
    smokeEveryDays: c.smoke.everyDays,
    smokeAt: c.smoke.at,
    smokeBranch: c.smoke.branch,
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
