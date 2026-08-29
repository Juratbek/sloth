import { lastRun } from './exits';

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
