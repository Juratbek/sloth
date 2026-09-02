import { cfg } from '../config';
import { remoteStatus } from '../remote';
import { comment } from './gh';

/** What the run is called on the issue: the command it runs, not the directory it books in. */
const NAMES: Record<string, string> = { implement: 'An implement', qa: 'A QA', review: 'A review' };
const nameOf = (prompt: string) => NAMES[/^\/sloth:(\w+)/.exec(prompt)?.[1] ?? ''] ?? 'A';

/**
 * Tells the issue where the run it just got can be watched: the monitor's page for the session, on
 * the tunnel's (or `publicUrl`'s) address. Only when `liveLinks` says so — the thread is readable by
 * everyone with access to the repository, so advertising the monitor there is opt-in. Without an
 * address there is nothing anybody off this machine could open, so nothing is written either. The
 * link is bare on purpose — a browser signed in through the QR opens it, and the single-use code
 * stays out of the thread.
 *
 * Trigger 6 reads any Sloth comment as "the answer was taken": this one lands after the relaunch the
 * answer caused, so it changes nothing for a parked card — the next question is a newer Sloth comment.
 */
export async function announce(issue: number, sessionId: string, prompt: string, model: string): Promise<void> {
  const c = cfg();
  if (!c.liveLinks) return;
  const url = remoteStatus().url;
  if (!url) return;
  await comment(c.repo, issue, `${c.botPrefix} ${nameOf(prompt)} session started on \`${model}\` — follow it live: ${url}/sessions/${sessionId}`);
}
