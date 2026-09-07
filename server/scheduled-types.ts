/**
 * The two runs Sloth starts by the clock rather than by the board: the daily QA sweep (trigger 9,
 * `runner/qa.ts`) and the scheduled smoke test (trigger 11, `runner/smoke.ts`). Their settings live in
 * `SlothConfig` (`config-types.ts`), which re-exports these.
 */

/**
 * The QA sweep (trigger 9): once a day, at `at` (`HH:MM`, this machine's clock), every card in the QA
 * column gets its own `/sloth:qa <issue>` session that checks the issue out on `branch` — the branch the
 * fixes are deployed from — boots the app and tests the fix as a user would. A pass moves the card to
 * Done, a fail to In Progress with the findings on the issue. No QA column, or an empty `at`, means no sweep.
 */
export interface QaConfig {
  /** The branch the sweep tests; empty is the repository's default branch. */
  branch: string;
  /** Local time of day the sweep starts, `HH:MM`; empty turns the sweep off. */
  at: string;
  /** A QA session's own time budget — one issue, one app boot, one browser run. */
  budgetMinutes: number;
}

/**
 * The smoke test (trigger 11, `runner/smoke.ts`): every `everyDays` days at `at`, one `/sloth:smoke` session
 * checks `branch` out at its current head, boots the app and has the browser tester walk the main flows of
 * every user role — happy paths only — then reports GO / NO-GO with the findings on a report issue and files
 * the serious ones as issues. `everyDays` of 1 is daily, 2 every second day, 7 weekly; 0 turns it off.
 */
export interface SmokeConfig {
  /** Days between two runs; `0` means no scheduled smoke test (**Test now** on the home panel still runs one). */
  everyDays: number;
  /** Local time of day a due run starts, `HH:MM`. */
  at: string;
  /** The branch under test; empty is the repository's default branch. */
  branch: string;
  /** The repository under test, `owner/name`; empty is the first configured one. One smoke test qualifies one app. */
  repo: string;
  /** The session's own time budget — one app boot, one browser pass per role. */
  budgetMinutes: number;
  /** What to smoke — the roles and their main flows, one per line; empty, the session reads them off the project's docs. */
  brief: string;
}

/** The sweep is on as soon as a QA column is chosen — at eight in the evening, once the day's merges are deployed. */
export const DEFAULT_QA: QaConfig = { branch: '', at: '20:00', budgetMinutes: 60 };
/** Off until asked for — a smoke test is a two-hour session of its own; early in the morning once it is, so the report is there when the day starts. */
export const DEFAULT_SMOKE: SmokeConfig = { everyDays: 0, at: '06:00', branch: '', repo: '', budgetMinutes: 120, brief: '' };
