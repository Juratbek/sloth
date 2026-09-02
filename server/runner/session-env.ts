import os from 'node:os';
import path from 'node:path';
import { cfg } from '../config';
import { EXTRA_DIRS } from '../install';
import { providerEnv } from '../models';
import { requiredStack } from '../stack-detect';
import { ASSETS_BRANCH } from './browser';
import { knownColumns } from './columns';
import { nowSec } from './log';
import { helpMentions } from './notify';

/**
 * Everything a session learns about the world before it starts: the board and its columns, the team,
 * the models, the budget. The commands read these and never hard-code an id — `plugin/README.md` is the
 * contract. Split out of `spawn.ts`, which does the starting.
 */

export const APPEND_PROMPT =
  'You run as a Sloth session; the SLOTH_* environment variables describe the board, the session directory and the time budget.';

/** cron / launchd-style bare PATHs miss homebrew (and the keg-only stack tools); a Sloth started from a shell keeps its own. */
const PATH_EXTRA = [...EXTRA_DIRS, path.join(os.homedir(), '.local/bin')];

export interface Target {
  issue?: number;
  pr?: number;
}

/** What differs between the kinds of run: the budget, and the worktree slot the run leased (a review has none). */
export interface SessionExtras {
  budgetMinutes?: number;
  /** The run's worktree under `worktreesDir` — the slot `leaseSlot` gave it. */
  worktree?: string;
  /** The slot's warm stack was inherited (`warm.ts`): servers and database are already up. */
  warm?: boolean;
  /** And it last served this very issue at this very head — a retry reuses it untouched. */
  warmSame?: boolean;
}

export function sessionEnv(dir: string, target: Target, model: string, chrome: boolean, extras: SessionExtras = {}): NodeJS.ProcessEnv {
  const c = cfg();
  const col = c.statusField.columns;
  const start = nowSec();
  const budget = extras.budgetMinutes ?? c.budgetMinutes;
  const worktree = extras.worktree ?? '';
  return {
    ...process.env,
    PATH: [...new Set([...(process.env.PATH ?? '').split(path.delimiter), ...PATH_EXTRA])].filter(Boolean).join(path.delimiter),
    // A model that is not Anthropic's is reached by pointing Claude Code at its provider (`models.ts`);
    // for Anthropic's own this is empty and the session keeps the machine's Claude Code credentials.
    ...providerEnv(model, process.env),
    SLOTH_SESSION_DIR: dir,
    ...(worktree ? { SLOTH_WORKTREE: path.join(c.worktreesDir, worktree) } : {}),
    // The warm-slot contract (`warm.ts`): `SLOTH_WARM_SLOTS` tells the session whether to leave its
    // stack running at teardown, the other two what it inherited and how much of the boot to skip.
    SLOTH_WARM_SLOTS: c.warmSlots ? '1' : '0',
    ...(extras.warm ? { SLOTH_WARM: '1' } : {}),
    ...(extras.warmSame ? { SLOTH_WARM_SAME: '1' } : {}),
    SLOTH_SCREENSHOTS_DIR: path.join(dir, 'screenshots'),
    SLOTH_ASSETS_BRANCH: ASSETS_BRANCH,
    ...(target.issue ? { SLOTH_ISSUE: String(target.issue) } : {}),
    ...(target.pr ? { SLOTH_PR: String(target.pr) } : {}),
    SLOTH_REPO: c.repo,
    SLOTH_PROJECT_ID: c.project.id,
    SLOTH_PROJECT_NUMBER: String(c.project.number),
    SLOTH_PROJECT_OWNER: c.project.owner,
    SLOTH_STATUS_FIELD_ID: c.statusField.id,
    SLOTH_COL_PICKUP_ID: col.pickup.id,
    SLOTH_COL_PICKUP_NAME: col.pickup.name,
    SLOTH_COL_IN_PROGRESS_ID: col.inProgress.id,
    SLOTH_COL_IN_PROGRESS_NAME: col.inProgress.name,
    SLOTH_COL_NEEDS_HELP_ID: col.needsHelp.id,
    SLOTH_COL_NEEDS_HELP_NAME: col.needsHelp.name,
    SLOTH_COL_CODE_REVIEW_ID: col.codeReview.id,
    SLOTH_COL_CODE_REVIEW_NAME: col.codeReview.name,
    SLOTH_COL_APPROVED_ID: col.approved.id,
    SLOTH_COL_APPROVED_NAME: col.approved.name,
    SLOTH_COL_QA_ID: col.qa.id,
    SLOTH_COL_QA_NAME: col.qa.name,
    SLOTH_COL_DONE_ID: col.done.id,
    SLOTH_COL_DONE_NAME: col.done.name,
    SLOTH_QA_BRANCH: c.qa.branch,
    SLOTH_COLUMNS: JSON.stringify(knownColumns()),
    SLOTH_RUNNER_ROOT: c.runnerRoot,
    SLOTH_WORKTREES_DIR: c.worktreesDir,
    SLOTH_ADMIN_LOGIN: c.roles.admin,
    SLOTH_DEVELOPER_LOGINS: c.roles.developers.join(' '),
    SLOTH_TESTER_LOGINS: c.roles.testers.join(' '),
    SLOTH_MODEL: model,
    SLOTH_ORCHESTRATOR: c.orchestrator ? '1' : '0',
    SLOTH_IMPLEMENTOR_MODEL: c.models.implement,
    SLOTH_TESTER_MODEL: c.models.tester,
    SLOTH_REVIEWER_MODEL: c.models.reviewer,
    SLOTH_CHROME: chrome ? '1' : '0',
    SLOTH_PREVIEW_HOURS: String(c.previewHours),
    SLOTH_STACK: requiredStack().join(' '),
    SLOTH_START: String(start),
    SLOTH_DEADLINE: String(start + budget * 60),
    SLOTH_BUDGET_MIN: String(budget),
    SLOTH_WAIT_HOURS: String(c.waitHours),
    SLOTH_REVIEW_ROUNDS: String(c.reviewRounds),
    SLOTH_BOT_PREFIX: c.botPrefix,
    SLOTH_MENTION: c.mention,
    SLOTH_HELP_MENTIONS: helpMentions(),
  };
}
