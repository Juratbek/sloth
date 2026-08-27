import fs from 'node:fs';
import path from 'node:path';
import { cfg } from './config';
import { costOf } from './pricing';
import { readRecords, type Rec } from './transcripts';
import type { ModelCost, UsageBucket, UsageSeries } from './types';

const HOUR = 3_600_000;
const TTL = 30_000;

/** Every main transcript plus every subagent file underneath it. */
function transcriptFiles(): string[] {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(cfg().transcriptsDir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    files.push(path.join(cfg().transcriptsDir, entry));
    const agents = path.join(cfg().transcriptsDir, entry.replace(/\.jsonl$/, ''), 'subagents');
    try {
      for (const f of fs.readdirSync(agents)) {
        if (/^agent-\w+\.jsonl$/.test(f)) files.push(path.join(agents, f));
      }
    } catch {
      /* no subagents for this session */
    }
  }
  return files;
}

/** Per-model dollars; `null` once a model with no list price shows up, so the headline can say so. */
type ModelSums = Map<string, number | null>;

/** One assistant record's spend, added to its hour and its model. Mirrors `summarize`: one row per requestId. */
function accumulate(records: Rec[], seen: Set<string>, sums: Map<number, UsageBucket>, models: ModelSums, since: number) {
  for (const r of records) {
    if (r.type !== 'assistant' || !r.message?.usage || !r.timestamp) continue;
    const at = Date.parse(r.timestamp);
    if (!Number.isFinite(at) || at < since) continue;
    const key: string = r.requestId ?? r.uuid;
    if (seen.has(key)) continue;
    seen.add(key);
    const hour = Math.floor(at / HOUR);
    const u = r.message.usage;
    const b = sums.get(hour) ?? { hour: '', newInput: 0, cacheRead: 0, output: 0, cost: 0 };
    const newInput = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    const cacheRead = u.cache_read_input_tokens ?? 0;
    const output = u.output_tokens ?? 0;
    b.newInput += newInput;
    b.cacheRead += cacheRead;
    b.output += output;
    sums.set(hour, b);
    // `<synthetic>` rows carry no tokens; listing them as unpriced would only add noise to the headline.
    if (newInput + cacheRead + output === 0) continue;
    const model: string = r.message.model ?? 'unknown';
    const cost = costOf(model, u);
    b.cost += cost ?? 0;
    models.set(model, cost === undefined ? null : (models.get(model) ?? 0) + cost);
  }
}

let cached: { at: number; days: number; value: UsageSeries } | undefined;

/** Hourly token spend across every transcript, oldest hour first, gaps filled with zeros. */
export function usageSeries(days: number): UsageSeries {
  const now = Date.now();
  if (cached && cached.days === days && now - cached.at < TTL) return cached.value;

  const lastHour = Math.floor(now / HOUR);
  const firstHour = lastHour - days * 24 + 1;
  const sums = new Map<number, UsageBucket>();
  const models: ModelSums = new Map();
  const seen = new Set<string>();
  for (const file of transcriptFiles()) {
    try {
      accumulate(readRecords(file), seen, sums, models, firstHour * HOUR);
    } catch {
      /* unreadable transcript */
    }
  }

  const buckets: UsageBucket[] = [];
  for (let h = firstHour; h <= lastHour; h++) {
    const b = sums.get(h);
    buckets.push({
      hour: new Date(h * HOUR).toISOString(),
      newInput: b?.newInput ?? 0,
      cacheRead: b?.cacheRead ?? 0,
      output: b?.output ?? 0,
      cost: b?.cost ?? 0,
    });
  }
  const byModel: ModelCost[] = [...models]
    .map(([model, cost]) => ({ model, cost }))
    .sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1));
  const value: UsageSeries = {
    from: new Date(firstHour * HOUR).toISOString(),
    to: new Date((lastHour + 1) * HOUR).toISOString(),
    buckets,
    cost: byModel.reduce((n, m) => n + (m.cost ?? 0), 0),
    byModel,
  };
  cached = { at: now, days, value };
  return value;
}
