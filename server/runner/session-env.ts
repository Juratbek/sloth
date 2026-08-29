import os from 'node:os';
import path from 'node:path';
import { cfg } from '../config';
import { EXTRA_DIRS } from '../install';
import { requiredStack } from '../stack-detect';
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

export function sessionEnv(dir: string, target: Target, model: string, chrome: boolean): NodeJS.ProcessEnv {
  const c = cfg();
  const col = c.statusField.columns;
  const start = nowSec();
  return {
    ...process.env,
    PATH: [...new Set([...(process.env.PATH ?? '').split(':'), ...PATH_EXTRA])].filter(Boolean).join(':'),
    SLOTH_SESSION_DIR: dir,
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
    SLOTH_COL_DONE_ID: col.done.id,
    SLOTH_COL_DONE_NAME: col.done.name,
    SLOTH_COLUMNS: JSON.stringify(knownColumns()),
    SLOTH_RUNNER_ROOT: c.runnerRoot,
    SLOTH_WORKTREES_DIR: c.worktreesDir,
    SLOTH_ADMIN_LOGIN: c.roles.admin,
    SLOTH_DEVELOPER_LOGINS: c.roles.developers.join(' '),
    SLOTH_TESTER_LOGINS: c.roles.testers.join(' '),
    SLOTH_MODEL: model,
    SLOTH_TESTER_MODEL: c.models.tester,
    SLOTH_REVIEWER_MODEL: c.models.reviewer,
    SLOTH_CHROME: chrome ? '1' : '0',
    SLOTH_PREVIEW_HOURS: String(c.previewHours),
    SLOTH_STACK: requiredStack().join(' '),
    SLOTH_START: String(start),
    SLOTH_DEADLINE: String(start + c.budgetMinutes * 60),
    SLOTH_BUDGET_MIN: String(c.budgetMinutes),
    SLOTH_WAIT_HOURS: String(c.waitHours),
    SLOTH_REVIEW_ROUNDS: String(c.reviewRounds),
    SLOTH_BOT_PREFIX: c.botPrefix,
    SLOTH_MENTION: c.mention,
    SLOTH_HELP_MENTIONS: helpMentions(),
  };
}
