/** The saved configuration (~/.sloth/config.json, path overridden with SLOTH_CONFIG) and the
 *  payloads the get-started wizard exchanges with /api/setup/*. */

import { DEFAULT_QA, DEFAULT_SMOKE, type QaConfig, type SmokeConfig } from './scheduled-types';
/** The scheduled runs' own settings (`scheduled-types.ts`), re-exported so every reader of the config finds them here. */
export { DEFAULT_QA, DEFAULT_SMOKE } from './scheduled-types';
export type { QaConfig, SmokeConfig } from './scheduled-types';

/** The board — where it lives and which of its columns Sloth uses — is typed in `board-config.ts`, re-exported here. */
export { BOARD_PROVIDERS, DEFAULT_COLUMN_NAMES, OPTIONAL_COLUMNS, OPT_IN_COLUMNS } from './board-config';
export type { BoardProvider, ColumnRef, ColumnRole, ConfigColumns, ConfigProject } from './board-config';
import type { ConfigColumns, ConfigProject } from './board-config';

/** How trigger 8 merges a PR that passed the review; `''` leaves merging — and the test in Approved — to a human. */
export type MergeMethod = '' | 'squash' | 'merge' | 'rebase';
export const MERGE_METHODS: MergeMethod[] = ['', 'squash', 'merge', 'rebase'];

/**
 * What the `helpWebhook` hears about. `needsHelp` is the one Sloth has always sent, and the only one a
 * config that predates the rest gets: an existing setup keeps behaving exactly as it did.
 */
export const WEBHOOK_EVENTS = ['needsHelp', 'codeReview', 'finalPassed', 'finalFailed', 'merged', 'qaPassed', 'qaFailed', 'smokePassed', 'smokeFailed', 'blocked', 'stopped', 'usageLimit', 'hoursTampered'] as const;
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
  /** `/sloth:smoke <n>` (trigger 11): the session that smoke-tests the whole app for a release; its role testers run on `tester`. */
  smoke: string;
  /** The e2e-writer subagent (`plugin/agents/e2e-writer.md`) an implement session spawns while `e2e` is on: one Playwright test per acceptance criterion, committed with the PR. */
  e2e: string;
}
export type AgentRole = keyof AgentModels;

export const DEFAULT_MODELS: AgentModels = { orchestrator: 'fable', implement: 'opus', tester: 'opus', reviewer: 'opus', final: 'fable', status: 'opus', qa: 'opus', e2e: 'opus', smoke: 'fable' };
export const AGENT_ROLES = Object.keys(DEFAULT_MODELS) as AgentRole[];

export interface SlothConfig {
  version: 1;
  repo: string;
  project: ConfigProject;
  /** The Status field the columns are options of; on Trello `id` is the board id again and the columns are its lists. */
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
  /** The comments poll while the GitHub webhook is not live (`server/webhook.ts`): polling is then the only way a mention is read at all, so it runs shorter than `commentSeconds`. */
  fallbackCommentSeconds: number;
  /**
   * How often the machine is read, in seconds — the holds above and the pausing in `pressure.ts` can
   * only act on a reading they have. Short: the board is read every few minutes, and a session that
   * boots an app, a build and a browser at once can exhaust the memory between two of those readings.
   */
  machineSeconds: number;
  /** One model per agent; a config from before this had `model` for every session and `approvedModel` for the final review. */
  models: AgentModels;
  /**
   * Run implement sessions as an orchestrator on `models.orchestrator` that delegates every code change to an
   * implementor subagent on `models.implement` (the default); off, the session on `models.implement` writes the
   * code itself. Either way the tester and the reviewer are subagents on their own models.
   */
  orchestrator: boolean;
  /** Give implement sessions a headless Chrome (Playwright MCP) for the tester subagent's screenshots. Needs Google Chrome (or Chromium) here. */
  chrome: boolean;
  /**
   * Have an implement session spawn the e2e-writer subagent (`models.e2e`) once the change works: one Playwright test
   * per acceptance criterion of the card, written into the project's own e2e suite and committed with the PR; the
   * review then holds a PR that counts tests to one per criterion. Only in a project that already has a Playwright setup. Off by default.
   */
  e2e: boolean;
  /** Start Sloth when this machine is logged into, through a macOS launch agent (`server/service.ts`). */
  autostart: boolean;
  /**
   * Install Sloth's own updates without being asked: every `updateSeconds` the watcher looks at
   * `origin/<branch>` and, when this checkout is behind it, runs the same pull-install-build-restart the
   * About page's button runs (`server/update.ts`). A checkout with local changes is left alone — the pull
   * is `--ff-only` and would refuse — and an update never starts inside a tick. On by default: a Sloth
   * left running for weeks should not fall behind the repository it was cloned from.
   */
  autoUpdate: boolean;
  /** How often `autoUpdate` looks at the remote, in seconds. Ignored while auto-update is off. At least 300. */
  updateSeconds: number;
  /**
   * How long a finished implement session's app stays up behind a public link posted on its PR, so a
   * reviewer can try the change without checking it out (see `runner/preview.ts`). `0` turns previews off.
   */
  previewHours: number;
  /**
   * Keep a slot's runtime stack — the dev servers, Redis and demo database a run booted — alive between
   * sessions (`runner/warm.ts`): the next run that leases the slot inherits it and skips the ten-minute
   * boot. Off, every run tears its stack down as before.
   */
  warmSlots: boolean;
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
  /**
   * Trigger 10 (`runner/lifecycle.ts`): a PR Sloth wrote that conflicts with its base, its card in Code Review, gets its
   * session sent back to merge the base in and resolve the conflicts, once per head; the review waits for the resolved head.
   */
  resolveConflicts: boolean;
  /**
   * Comment a "follow it live" link to the session's monitor page on the issue a run starts for. The link is on
   * the public address, in a thread everyone with read access can see — so off by default, tunnel or `publicUrl` or not.
   */
  liveLinks: boolean;
  /** The argv Sloth runs to reach the UI from outside; `{port}` is the UI's port. The first bare https URL it prints is the address. */
  tunnel: string[];
  /** Where the UI is already reachable (your own tunnel or domain). Set, no tunnel is started. */
  publicUrl: string;
  /** What the sessions' app needs on this machine (see `STACK`); `auto` detects it from the checkout. */
  stack: StackChoice;
  /** The daily QA sweep of the QA column (trigger 9, `runner/qa.ts`); off until `at` is set. */
  qa: QaConfig;
  /** The scheduled smoke test of the whole app (trigger 11, `runner/smoke.ts`); off until `everyDays` is set. */
  smoke: SmokeConfig;
}

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
  fallbackCommentSeconds: 30,
  machineSeconds: 15,
  models: DEFAULT_MODELS,
  orchestrator: true,
  chrome: true,
  e2e: false,
  autostart: false,
  autoUpdate: true,
  updateSeconds: 3600,
  previewHours: 24,
  warmSlots: true,
  keepDays: 30,
  priorityField: 'Priority',
  helpLogins: [] as string[],
  helpWebhook: '',
  webhookEvents: ['needsHelp'] as WebhookEvent[],
  autoMerge: '' as MergeMethod,
  resolveConflicts: false,
  liveLinks: false,
  tunnel: DEFAULT_TUNNEL,
  publicUrl: '',
  stack: 'auto' as StackChoice,
  qa: DEFAULT_QA,
  smoke: DEFAULT_SMOKE,
} satisfies Partial<SlothConfig>;

/**
 * Where an instance keeps its files: under its home — the directory its config file is in, `~/.sloth`
 * by default — and, for the per-repository ones, under the repository's name (the part after the slash).
 */
export const defaultDirs = (name: string, home = '~/.sloth') => ({
  runnersDir: `${home}/runners`,
  runnerRoot: `${home}/runners/${name}`,
  worktreesDir: `${home}/worktrees/${name}`,
  sessionsDir: `${home}/sessions/${name}`,
  stateDir: `${home}/state`,
  watcherLog: `${home}/watcher.log`,
});

/** The payloads the get-started wizard exchanges with `/api/setup/*` (`setup-types.ts`). */
export type { FieldOption, SetupCheck, SetupEnv, SetupFields, SetupProject } from './setup-types';
