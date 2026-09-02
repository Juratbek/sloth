/** The target a log line is about, prefix and all — `#12`, `QA #12`, `review PR #12` — so the kinds do not collide. */
const TARGET = /(?:(?:final )?review PR |QA )?#(\d+)/;
/** The line took the target out of the queue: it started (or would have, in a dry run), was stopped, parked, or answered. */
const STARTED = /^(?:dry-run: would )?(?:launch|review|answer)\b/;
const LEFT = /^(?:QA |(?:final )?review PR )?#\d+ (?:stopped:|parked in place|status reply)/;

/**
 * The queue as the log tells it: a "queued (slots full)" / "queued (machine busy …)" line stands until
 * the same target starts — or leaves the queue any other way: a dry run that would have launched it, a
 * stop, a park in place. Without those the chip went on counting a card long gone from the queue.
 */
export function queued(logTail: string[]): string[] {
  const pending = new Set<string>();
  for (const raw of logTail) {
    const line = raw.replace(/^\[[^\]]+\] /, '');
    const target = TARGET.exec(line)?.[0];
    if (!target) continue;
    if (/queued \(/.test(line)) pending.add(target);
    else if (STARTED.test(line) || LEFT.test(line)) pending.delete(target);
  }
  return [...pending];
}
