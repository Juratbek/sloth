import fs from 'node:fs';
import path from 'node:path';
import { digestFile, feed, newDigest, statsOf, type Digest, type Rec } from './transcripts';
import type { AgentSummary } from './types';

export function agentsDirOf(sessionFile: string) {
  return path.join(sessionFile.replace(/\.jsonl$/, ''), 'subagents');
}

/** The subagent files under a session's transcript, each folded into its digest — no records kept. */
export function listAgents(sessionFile: string): AgentSummary[] {
  const dir = agentsDirOf(sessionFile);
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^agent-\w+\.jsonl$/.test(f));
  } catch {
    return [];
  }
  return files.map((f) => {
    const d = digestFile(path.join(dir, f));
    return { agentId: f.slice(6, -6), prompt: (d.firstUser ?? '').slice(0, 4000), ...statsOf(d) };
  });
}

/** Attaches description / type / model from the parent's Agent tool calls; returns toolUseId → agentId. */
export function applyLinks(d: Digest, agents: AgentSummary[]): Map<string, string> {
  const byToolUse = new Map(d.resultAgent);
  for (const call of d.calls) {
    const agent = agents.find((a) => a.agentId === byToolUse.get(call.id)) ?? agents.find((a) => !a.toolUseId && a.prompt === call.prompt);
    if (!agent) continue;
    byToolUse.set(call.id, agent.agentId);
    agent.toolUseId = call.id;
    agent.description = call.description;
    agent.subagentType = call.subagentType;
    agent.model = call.model ?? agent.byModel[0]?.model;
  }
  return byToolUse;
}

/** The same from a parent's records — the detail views, which have them in hand. */
export function linkAgents(records: Rec[], agents: AgentSummary[]): Map<string, string> {
  const d = newDigest();
  feed(d, records);
  return applyLinks(d, agents);
}
