import type { IssueCost, SessionSummary } from './types';

/**
 * The per-issue rollup the home panel shows. A session's directory says which issue it belongs to:
 * an implement run is named after it, a review after the PR — with the issue written
 * beside it at launch (`spawn.ts`). A transcript that belongs to neither (a run started by hand, a
 * review from before the `issue` file existed) is left out rather than guessed at.
 */

/** Which issue a run belongs to; `board-view.ts` asks the same question when it picks a card's newest run. An implement run and a QA test are both named after theirs. */
export const issueOf = (s: SessionSummary): number | undefined =>
  s.watcher?.kind === 'issue' || s.watcher?.kind === 'qa'
    ? s.watcher.target
    : (s.watcher?.issue ?? (s.kind === 'sloth:implement' || s.kind === 'sloth:qa' ? s.target : undefined));

/** Dearest first; an unpriced issue has no number to compare, so it sits after the priced ones. */
const byCost = (a: IssueCost, b: IssueCost) => (b.cost ?? -1) - (a.cost ?? -1);

export function rollup(sessions: SessionSummary[], titleOf: (issue: number) => string | undefined): IssueCost[] {
  const out = new Map<number, IssueCost>();
  // `sessions` arrives newest first, so the first row an issue gets is the one whose status counts.
  for (const s of sessions) {
    const issue = issueOf(s);
    if (!issue) continue;
    const row = out.get(issue) ?? {
      issue,
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
    out.set(issue, row);
  }
  return [...out.values()].sort(byCost);
}
