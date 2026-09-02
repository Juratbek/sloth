import fs from 'node:fs';
import path from 'node:path';
import { cfg } from '../config';
import { lastRun } from './exits';
import { readFile } from './log';
import type { Rec } from '../jsonl';

/**
 * Whether a run ended because Claude ran out of allowance — the one ending that pauses the whole watcher
 * rather than the card (`run-control.ts`), since every other session would hit the same wall.
 *
 * Two ways of telling, in this order. The transcript is the structured one: Claude Code writes the API's
 * own error entries into the session's `.jsonl`, and a rate limit is named there by its *type*
 * (`rate_limit_error`) or its status (429) — a field, not a sentence. The run log is the fallback and was
 * for a long time all there was: the CLI's prose on the way out, matched against the phrasings it prints.
 * The caller logs which of the two fired, so a phrasing Anthropic changes shows up as "structured" alone
 * and a transcript shape that changed shows up as "matched log text" alone.
 *
 * There is no third, cheaper signal to prefer: `spawn.ts` starts `claude` detached with its stdout
 * appended to `run.log` and no `--output-format json`, so there is no result envelope to read, and nobody
 * waits for the child — the exit code is never seen, and `exits.ts` records how Sloth *found* the run,
 * not what the process returned.
 */

// Claude's own usage-limit failure — the phrasings its CLI prints when a limit stops a session.
const LIMIT_RE =
  /Claude (AI )?usage limit reached|[Uu]sage limit reached|You.{0,3}ve hit your ([0-9]+-hour|weekly|individual usage|individual spend|usage|usage credit) limit|reached your (weekly|specified) .*usage limit/;

/**
 * True when a session's run log ends on a usage limit. Only the newest run counts — a relaunch that
 * died silently must not re-read the limit its predecessor hit — and only short lines on the exit path:
 * a long final report may quote GitHub's rate limits and would otherwise pause the whole watcher.
 */
export function limitExit(runLog: string | undefined): boolean {
  if (!runLog) return false;
  return lastRun(runLog)
    .trimEnd()
    .split('\n')
    .slice(-5)
    .some((line) => line.length > 0 && line.length < 300 && LIMIT_RE.test(line));
}

/** The error types an over-quota answer carries; a 429 says the same thing in the status. */
const RATE_TYPES = new Set(['rate_limit_error', 'usage_limit_error', 'usage_limit_reached', 'overloaded_error_usage_limit']);
const TAIL_BYTES = 64 << 10; // the end of the transcript: the entries the run died on
const TAIL_RECORDS = 5; // as few as the log's last lines — a 429 the session recovered from is not an exit

/** Whether the API's error entries mark one of these as an error rather than an answer. */
const errorRecord = (r: Rec): boolean =>
  !!r &&
  (r.isApiErrorMessage === true ||
    r.type === 'error' ||
    (r.type === 'result' && (r.is_error === true || String(r.subtype ?? '').includes('error'))) ||
    (r.type === 'system' && (r.level === 'error' || r.subtype === 'error' || r.subtype === 'api_error')));

/**
 * Whether a rate limit is named anywhere inside an error entry — as `type`, or as the status of the
 * answer. The provider's JSON body arrives as text inside an API-error entry, so a string that holds one
 * is parsed rather than searched: this must not fire on prose that merely says "rate limit", which is
 * what the regex above is for.
 */
function rateLimited(value: unknown, depth = 0): boolean {
  if (depth > 6) return false;
  if (typeof value === 'string') {
    const at = value.indexOf('{');
    if (at < 0 || value.length > 8000) return false;
    try {
      return rateLimited(JSON.parse(value.slice(at)), depth + 1);
    } catch {
      return false;
    }
  }
  if (!value || typeof value !== 'object') return false;
  const o = value as Record<string, unknown>;
  if (typeof o.type === 'string' && RATE_TYPES.has(o.type)) return true;
  if (o.status === 429 || o.statusCode === 429 || o.code === 429) return true;
  return Object.values(o).some((v) => rateLimited(v, depth + 1));
}

/** The last records of a .jsonl, read from the end — a transcript is megabytes and only its end matters. */
function tailRecords(file: string): Rec[] {
  let text = '';
  try {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(Math.min(size, TAIL_BYTES));
      fs.readSync(fd, buf, 0, buf.length, size - buf.length);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
  const lines = text.split('\n').filter((l) => l.trim());
  // The first line of a tail read is half a record unless the read began at the file's start.
  if (text.length === TAIL_BYTES) lines.shift();
  const records: Rec[] = [];
  for (const line of lines.slice(-TAIL_RECORDS)) {
    try {
      records.push(JSON.parse(line));
    } catch {
      /* a line still being written */
    }
  }
  return records;
}

/** The structured half: the run's own transcript (`session_id` is rewritten at every launch) ends on a rate limit. */
function limitInTranscript(dir: string): boolean {
  const id = readFile(path.join(dir, 'session_id'))?.trim();
  if (!id || !/^[\w-]+$/.test(id)) return false;
  return tailRecords(path.join(cfg().transcriptsDir, `${id}.jsonl`)).some((r) => errorRecord(r) && rateLimited(r));
}

/** Which signal said so, for the log — `undefined` when this run did not end on a usage limit. */
export type LimitSignal = 'structured' | 'matched log text';

/** How a run in `dir` hit a usage limit, if it did: the transcript first, the run log's prose after. */
export function usageLimit(dir: string): LimitSignal | undefined {
  if (limitInTranscript(dir)) return 'structured';
  return limitExit(readFile(path.join(dir, 'run.log'))) ? 'matched log text' : undefined;
}
