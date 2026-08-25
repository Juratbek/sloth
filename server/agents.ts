import fs from 'node:fs';
import path from 'node:path';
import { readRecords, summarize } from './transcripts';
import type { AgentSummary } from './types';
import type { Rec } from './transcripts';

export function agentsDirOf(sessionFile: string) {
  return path.join(sessionFile.replace(/\.jsonl$/, ''), 'subagents');
}

export function listAgents(sessionFile: string): AgentSummary[] {
  const dir = agentsDirOf(sessionFile);
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^agent-\w+\.jsonl$/.test(f));
  } catch {
    return [];
  }
  return files.map((f) => {
    const recs = readRecords(path.join(dir, f));
    const first = recs.find((r) => r.type === 'user' && typeof r.message?.content === 'string');
    return { agentId: f.slice(6, -6), prompt: (first?.message.content ?? '').slice(0, 4000), ...summarize(recs) };
  });
}

/** Attaches description / type / model from the parent's Agent tool calls; returns toolUseId → agentId. */
export function linkAgents(records: Rec[], agents: AgentSummary[]): Map<string, string> {
  const byToolUse = new Map<string, string>();
  for (const r of records) {
    const id = r.toolUseResult?.agentId;
    const toolUseId = Array.isArray(r.message?.content) ? r.message.content[0]?.tool_use_id : undefined;
    if (r.type === 'user' && id && toolUseId) byToolUse.set(toolUseId, id);
  }
  for (const r of records) {
    if (r.type !== 'assistant') continue;
    for (const b of r.message?.content ?? []) {
      if (b.type !== 'tool_use' || (b.name !== 'Agent' && b.name !== 'Task')) continue;
      const prompt: string = b.input?.prompt ?? '';
      const agent =
        agents.find((a) => a.agentId === byToolUse.get(b.id)) ??
        agents.find((a) => !a.toolUseId && a.prompt === prompt.slice(0, 4000));
      if (!agent) continue;
      byToolUse.set(b.id, agent.agentId);
      agent.toolUseId = b.id;
      agent.description = b.input?.description;
      agent.subagentType = b.input?.subagent_type;
      agent.model = b.input?.model ?? agent.byModel[0]?.model;
    }
  }
  return byToolUse;
}
