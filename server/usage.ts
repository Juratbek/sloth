import fs from 'node:fs';
import path from 'node:path';
import { cfg } from './config';
import { readRecords, type Rec } from './transcripts';
import type { UsageBucket, UsageSeries } from './types';

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

/** One assistant record's spend, added to its hour. Mirrors `summarize`: one row per requestId. */
function accumulate(records: Rec[], seen: Set<string>, sums: Map<number, UsageBucket>, since: number) {
  for (const r of records) {
    if (r.type !== 'assistant' || !r.message?.usage || !r.timestamp) continue;
    const at = Date.parse(r.timestamp);
    if (!Number.isFinite(at) || at < since) continue;
    const key: string = r.requestId ?? r.uuid;
    if (seen.has(key)) continue;
    seen.add(key);
    const hour = Math.floor(at / HOUR);
    const u = r.message.usage;
    const b = sums.get(hour) ?? { hour: '', newInput: 0, cacheRead: 0, output: 0 };
    b.newInput += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    b.cacheRead += u.cache_read_input_tokens ?? 0;
    b.output += u.output_tokens ?? 0;
    sums.set(hour, b);
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
  const seen = new Set<string>();
  for (const file of transcriptFiles()) {
    try {
      accumulate(readRecords(file), seen, sums, firstHour * HOUR);
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
    });
  }
  const value: UsageSeries = {
    from: new Date(firstHour * HOUR).toISOString(),
    to: new Date((lastHour + 1) * HOUR).toISOString(),
    buckets,
  };
  cached = { at: now, days, value };
  return value;
}
