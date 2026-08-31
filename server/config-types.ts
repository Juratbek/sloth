/** The saved configuration (~/.sloth/config.json, path overridden with SLOTH_CONFIG) and the
 *  payloads the get-started wizard exchanges with /api/setup/*. */

export interface ColumnRef {
  id: string;
  name: string;
}
export interface ConfigProject {
  id: string;
  number: number;
  owner: string;
  title: string;
}
export interface ConfigColumns {
  pickup: ColumnRef;
  inProgress: ColumnRef;
  needsHelp: ColumnRef;
  codeReview: ColumnRef;
  /** Optional: with no Approved column a passing review leaves the card in Code Review and trigger 5 never fires. */
  approved: ColumnRef;
  /**
   * Optional: the column the QA sweep (trigger 9) tests — cards whose fix is merged and deployed to
   * `qa.branch`, waiting for a tester. Never created unless asked for; blank means no sweep.
   */
  qa: ColumnRef;
  /** Optional: where a card goes once its issue is closed (trigger 6), or once it passed the QA sweep; without it the card stays put. */
  done: ColumnRef;
}
export type ColumnRole = keyof ConfigColumns;

/** The names Sloth gives the columns it creates when the board has none for a role. */
export const DEFAULT_COLUMN_NAMES: Record<ColumnRole, string> = {
  pickup: 'Todo',
  inProgress: 'In Progress',
  needsHelp: 'Sloth needs help',
  codeReview: 'Code Review',
  approved: 'Approved',
  qa: 'QA',
  done: 'Done',
};

/** The roles a board need not have: left blank, the trigger that needs the column simply never fires. */
export const OPTIONAL_COLUMNS: ColumnRole[] = ['needsHelp', 'approved', 'qa', 'done'];
/** The roles that are never created unasked — the wizard offers "none" for them, and blank stays blank. */
export const OPT_IN_COLUMNS: ColumnRole[] = ['qa'];

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

/** How trigger 8 merges a PR that passed the review; `''` leaves merging — and the test in Approved — to a human. */
export type MergeMethod = '' | 'squash' | 'merge' | 'rebase';
export const MERGE_METHODS: MergeMethod[] = ['', 'squash', 'merge', 'rebase'];

/**
 * What the `helpWebhook` hears about. `needsHelp` is the one Sloth has always sent, and the only one a
 * config that predates the rest gets: an existing setup keeps behaving exactly as it did.
 */
export const WEBHOOK_EVENTS = ['needsHelp', 'codeReview', 'finalPassed', 'finalFailed', 'merged', 'qaPassed', 'qaFailed', 'blocked', 'stopped', 'usageLimit'] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** One admin, any number of developers and testers. A login holds one role: admin wins, then developer. */
export interface Roles {
  /** Orders anything — work, board moves, closing issues. Empty means nobody can. */
  admin: string;
  /** Order work on an issue, within that issue. */
  developers: string[];
  /** Answer a parked card's questions and ask for status; never order. */
  testers: string[];
}

/**
 * Which model each of Sloth's agents runs on — a Claude Code `--model` value: an alias (`opus`, `fable`)
 * or a full model id. Settings → Models edits it.
 */
export interface AgentModels {
  /**
   * The orchestrator an implement session runs on when `orchestrator` is on: it claims the card, briefs
   * an implementor subagent (on `implement`), verifies, runs the tester and the reviewer, opens the PR —
   * and never edits code itself.
   */
  orchestrator: string;
  /** The implement session: claims the card, writes the code, opens the PR (triggers 1–3). With `orchestrator` on, the implementor subagent that writes the code. */
  implement: string;
  /** The tester subagent an implement session spawns to click through the change in a headless Chrome and screenshot it. */
  tester: string;
  /** The reviewer subagent an implement session asks before it hands the PR over. */
  reviewer: string;
  /** `/sloth:review … final` of a Code Review card's PR (trigger 4) — the review that moves a card to Approved. */
  final: string;
  /** `/sloth:status`: the reply to an @sloth question when no session is running. */
  status: string;
  /** `/sloth:qa <issue>` (trigger 9): the session that tests one QA card on the QA branch; its browser tester runs on `tester`. */
  qa: string;
}
export type AgentRole = keyof AgentModels;

export const DEFAULT_MODELS: AgentModels = { orchestrator: 'fable', implement: 'opus', tester: 'opus', reviewer: 'opus', final: 'fable', status: 'opus', qa: 'opus' };
export const AGENT_ROLES = Object.keys(DEFAULT_MODELS) as AgentRole[];

export interface SlothConfig {
  version: 1;
  repo: string;
  project: ConfigProject;
  statusField: { id: string; columns: ConfigColumns };
  /** The checkout the sessions run from; Sloth clones the repo here. */
  runnerRoot: string;
  runnersDir: string;
  worktreesDir: string;
  sessionsDir: string;
  stateDir: string;
  watcherLog: string;
  /** Who may talk to Sloth (see `roles.ts`); a saved `orderLogin` from an older config loads as the admin. */
  roles: Roles;
  mention: string;
  botPrefix: string;
  /** Sessions working at once — and the size of the worktree pool the implement and QA runs lease from (`slots.ts`). */
  maxActive: number;
  maxAlive: number;
  /**
   * The machine's own limit: no session starts while less than this percent of the memory is available
   * (`minFreeMemory`), of the CPU is idle (`minIdleCpu`) or of the busiest disk is idle (`minIdleDisk`) —
   * running sessions go on, new work waits for the next tick. `0` turns a check off.
   */
  minFreeMemory: number;
  minIdleCpu: number;
  minIdleDisk: number;
  budgetMinutes: number;
  waitHours: number;
  reviewRounds: number;
  maxRetries: number;
  boardSeconds: number;
  commentSeconds: number;
  /**
   * How often the machine is read, in seconds — the holds above and the pausing in `pressure.ts` can
   * only act on a reading they have. Short: the board is read every few minutes, and a session that
   * boots an app, a build and a browser at once can exhaust the memory between two of those readings.
   */
  machineSeconds: number;
  /** One model per agent; a config from before this had `model` for every session and `approvedModel` for the final review. */
  models: AgentModels;
  /**
   * Run implement sessions as an orchestrator on `models.orchestrator` that delegates every code change
   * to an implementor subagent on `models.implement` (the default); off, the session on `models.implement` writes the
   * code itself. Either way the tester and the reviewer are subagents on their own models.
   */
  orchestrator: boolean;
  /**
   * Give implement sessions a headless Chrome (Playwright MCP), so a tester subagent can click through the
   * change and screenshot it for the PR. Needs Google Chrome (or Chromium) on this machine.
   */
  chrome: boolean;
  /** Start Sloth when this machine is logged into, through a macOS launch agent (`server/service.ts`). */
  autostart: boolean;
  /**
   * How long a finished implement session's app stays up behind a public link posted on its PR, so a
   * reviewer can try the change without checking it out (see `runner/preview.ts`). `0` turns previews off.
   */
  previewHours: number;
  /**
   * How long a finished run is kept: its session directory, its transcript under `~/.claude/projects` and
   * the markers of the status replies it prompted. Worktrees are not kept: a run's leftover per-issue
   * checkout goes as soon as it is over, and the pool's slots are reused.
   */
  keepDays: number;
  /**
   * A single-select field on the board whose option order ranks the watched column: cards are picked up
   * first option first. Empty means board order.
   */
  priorityField: string;
  /** GitHub logins `@`-mentioned in the comment Sloth writes when it parks a card in the needs-help column. */
  helpLogins: string[];
  /** Optional URL POSTed (Slack / Discord incoming-webhook shape) when one of `webhookEvents` happens. */
  helpWebhook: string;
  /** Which events reach `helpWebhook`; empty means none, and the URL is never called. */
  webhookEvents: WebhookEvent[];
  /**
   * Merge a PR once its review passed, its checks are green and it merges cleanly — with this
   * `gh pr merge` method, as soon as it passes: the human test in Approved is skipped. Empty (the default)
   * leaves the merge to a human.
   */
  autoMerge: MergeMethod;
  /** The argv Sloth runs to reach the UI from outside; `{port}` is the UI's port. The first bare https URL it prints is the address. */
  tunnel: string[];
  /** Where the UI is already reachable (your own tunnel or domain). Set, no tunnel is started. */
  publicUrl: string;
  /** What the sessions' app needs on this machine (see `STACK`); `auto` detects it from the checkout. */
  stack: StackChoice;
  /** The daily QA sweep of the QA column (trigger 9, `runner/qa.ts`); off until `at` is set. */
  qa: QaConfig;
}

/** The sweep is on as soon as a QA column is chosen — at eight in the evening, once the day's merges are deployed. */
export const DEFAULT_QA: QaConfig = { branch: '', at: '20:00', budgetMinutes: 60 };

export const DEFAULT_TUNNEL = ['cloudflared', 'tunnel', '--url', 'http://localhost:{port}'];

/**
 * The stack Sloth knows how to install on the machine it runs on (`server/stack.ts`): the only tools a
 * project may ask for. A session cannot boot an app whose database or runtime is missing, so the wizard
 * installs what the project needs before the first run, and every start of Sloth installs what is
 * still missing.
 */
export const STACK = ['postgresql', 'redis', 'node', 'python', 'java'] as const;
export type StackId = (typeof STACK)[number];
/** Which of `STACK` this project needs: an explicit list, or `auto` — read off the checkout at every start. */
export type StackChoice = StackId[] | 'auto';

/**
 * Every value with a default: what a saved config gets when it leaves the key out, and what Settings'
 * "Restore defaults" puts back. The per-repository directories are `defaultDirs`.
 */
export const CONFIG_DEFAULTS = {
  runnersDir: '~/.sloth/runners',
  stateDir: '~/.sloth/state',
  watcherLog: '~/.sloth/watcher.log',
  mention: '@sloth',
  botPrefix: '**Sloth:**',
  maxActive: 2,
  maxAlive: 3,
  minFreeMemory: 10,
  minIdleCpu: 5,
  minIdleDisk: 10,
  budgetMinutes: 60,
  waitHours: 2,
  reviewRounds: 4,
  maxRetries: 2,
  boardSeconds: 300,
  commentSeconds: 120,
  machineSeconds: 15,
  models: DEFAULT_MODELS,
  orchestrator: true,
  chrome: true,
  autostart: false,
  previewHours: 24,
  keepDays: 30,
  priorityField: 'Priority',
  helpLogins: [] as string[],
  helpWebhook: '',
  webhookEvents: ['needsHelp'] as WebhookEvent[],
  autoMerge: '' as MergeMethod,
  tunnel: DEFAULT_TUNNEL,
  publicUrl: '',
  stack: 'auto' as StackChoice,
  qa: DEFAULT_QA,
} satisfies Partial<SlothConfig>;

/** The directories that are kept apart per repository (`name` is the part after the slash). */
export const defaultDirs = (name: string) => ({
  runnerRoot: `~/.sloth/runners/${name}`,
  worktreesDir: `~/.sloth/worktrees/${name}`,
  sessionsDir: `~/.sloth/sessions/${name}`,
});

/** The payloads the get-started wizard exchanges with `/api/setup/*` (`setup-types.ts`). */
export type { FieldOption, SetupCheck, SetupEnv, SetupFields, SetupProject } from './setup-types';
