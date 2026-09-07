import { refKey, type IssueRef } from './repo-types';
import type { IssueCost, SessionSummary } from './types';

/**
 * The per-issue rollup the home panel shows. A session's directory says which issue it belongs to:
 * an implement run is named after it, a review after the PR — with the issue written
 * beside it at launch (`spawn.ts`). A transcript that belongs to neither (a run started by hand, a
 * review from before the `issue` file existed) is left out rather than guessed at.
 */

/**
 * Which issue a run belongs to; `board-view.ts` asks the same question when it picks a card's newest run.
 * An implement run and a QA test are both named after theirs, in their own repository; a review's issue
 * is written beside it, with its repository when that is not the PR's.
 */
export function issueOf(s: SessionSummary): IssueRef | undefined {
  const w = s.watcher;
  if (w?.kind === 'issue' || w?.kind === 'qa') return { repo: w.repo, number: w.target };
  if (w?.issue) return { repo: w.issueRepo ?? w.repo, number: w.issue };
  if (w) return undefined;
  return (s.kind === 'sloth:implement' || s.kind === 'sloth:qa') && s.target ? { repo: s.repo, number: s.target } : undefined;
}

/** Dearest first; an unpriced issue has no number to compare, so it sits after the priced ones. */
const byCost = (a: IssueCost, b: IssueCost) => (b.cost ?? -1) - (a.cost ?? -1);

export function rollup(sessions: SessionSummary[], titleOf: (issue: IssueRef) => string | undefined): IssueCost[] {
  const out = new Map<string, IssueCost>();
  // `sessions` arrives newest first, so the first row an issue gets is the one whose status counts.
  for (const s of sessions) {
    const issue = issueOf(s);
    if (!issue) continue;
    const key = refKey(issue);
    const row = out.get(key) ?? {
      repo: issue.repo,
      issue: issue.number,
      title: titleOf(issue),
      sessions: 0,
      cost: 0 as number | null,
      tokens: { input: 0, output: 0, cacheRead: 0 },
      lastAt: s.lastAt,
      status: s.status,
    };
    row.sessions++;
    // One unpriced run makes the issue unpriced: a total missing a run is worse than no total.
    row.cost = row.cost === null || s.cost === null ? null : row.cost + s.cost;
    row.tokens.input += s.usage.input + s.agentsUsage.input;
    row.tokens.output += s.usage.output + s.agentsUsage.output;
    row.tokens.cacheRead += s.usage.cacheRead + s.agentsUsage.cacheRead;
    if ((s.lastAt ?? '') > (row.lastAt ?? '')) row.lastAt = s.lastAt;
    out.set(key, row);
  }
  return [...out.values()].sort(byCost);
}
