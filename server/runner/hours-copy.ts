import fs from 'node:fs';
import { cfg } from '../config';
import type { HoursIntegrity } from '../hours-types';
import { ASSETS_BRANCH } from './browser';
import { run, type Ran } from './gh';
import { ledgerFile, readLedger, unpublishedFile } from './hours';
import { isDry, log, nowSec, readFile, remove, write } from './log';
import { statePath } from './markers';
import { notify } from './notify';
import { primaryRepo, repoRoot } from '../repos';

/**
 * The ledger's second witness: a copy of `hours.jsonl` on the watched repository's `sloth-assets` branch,
 * the one that already holds the PR screenshots. Committed the way `publish_shots` commits — a tree built
 * from a throwaway index in the runner checkout, so nothing is checked out and the worktree is untouched —
 * once per run booked, so the branch's history is one commit per run and a deletion is a visible
 * force-push. The customer's own repository holds it, so both sides can read the hours as they accrue.
 *
 * The tick compares the two (`checkCopy`): the branch must be a prefix of the local file — equal, or a
 * few lines behind while a push is pending. Anything else is a `diverged` copy, and that, like a broken
 * chain in the file itself, is raised once through the help webhook as `hoursTampered`.
 */

const LEDGER_PATH = 'hours/ledger.jsonl';
const REMOTE = `refs/remotes/origin/${ASSETS_BRANCH}`;
/** How often the copy is compared when nothing is waiting to be pushed. */
const CHECK_EVERY = 3600;
const PUSH_TRIES = 3;
/** How long the branch may stay out of reach before that is raised like a tampered copy. */
const UNREACHABLE_ALARM = 24 * 3600;

const statusFile = () => statePath('hours_copy.json');
const noticeFile = () => statePath('notified', 'hoursTampered');

/** `lines` is the most lines the branch was ever seen to hold: a copy shorter than that, or gone, was rewritten. */
type CopyStatus = Pick<HoursIntegrity, 'copy' | 'checkedAt'> & { problem?: string; unreachableSince?: number; lines?: number };

/** What the last comparison found; `unchecked` until the tick has done one. */
export function copyStatus(): CopyStatus {
  try {
    return JSON.parse(readFile(statusFile()) ?? '') as CopyStatus;
  } catch {
    return { copy: 'unchecked' };
  }
}

/** The ledger's witness is the first repository's `sloth-assets` branch: one project, one record, whatever else Sloth watches for it. */
const git = (args: string[], env?: NodeJS.ProcessEnv): Promise<Ran> => run('git', ['-C', repoRoot(primaryRepo()), ...args], { timeout: 120_000, ...(env ? { env } : {}) });

/** The branch's head: a sha, `undefined` when the branch does not exist yet, `null` when origin cannot be asked. */
async function remoteHead(): Promise<string | undefined | null> {
  const ls = await git(['ls-remote', '--heads', 'origin', ASSETS_BRANCH]);
  if (!ls.ok) return null;
  if (!ls.out) return undefined;
  const f = await git(['fetch', '-q', 'origin', `+refs/heads/${ASSETS_BRANCH}:${REMOTE}`]);
  if (!f.ok) return null;
  const r = await git(['rev-parse', REMOTE]);
  return r.ok && r.out ? r.out : null;
}

/** One commit holding the ledger on top of `parent`, out of an index of its own. False when git refused. */
async function commitLedger(parent: string | undefined, message: string): Promise<string | undefined> {
  const index = statePath('hours.index');
  remove(index);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    if (parent && !(await git(['read-tree', parent], env)).ok) return undefined;
    const blob = await git(['hash-object', '-w', ledgerFile()]);
    if (!blob.ok) return undefined;
    if (!(await git(['update-index', '--add', '--cacheinfo', `100644,${blob.out},${LEDGER_PATH}`], env)).ok) return undefined;
    const tree = await git(['write-tree'], env);
    if (!tree.ok) return undefined;
    const commit = await git(['commit-tree', tree.out, ...(parent ? ['-p', parent] : []), '-m', message]);
    return commit.ok ? commit.out : undefined;
  } finally {
    remove(index);
  }
}

/**
 * Pushes the ledger as it stands — provided it only adds to what the branch already holds. The branch is
 * the witness: a local file whose chain is broken, or whose lines no longer match the branch's, is never
 * pushed over it, however it got that way, so the copy keeps the record as it was and the tick raises the
 * difference. A push that loses the race to a session's `publish_shots` is retried on the new head; one
 * that fails for good (offline, no branch permission) leaves the marker, and the next tick tries again.
 */
export async function publishHours(): Promise<boolean> {
  if (!fs.existsSync(ledgerFile())) return true;
  if (isDry()) {
    log(`dry-run: would copy the hours ledger to ${ASSETS_BRANCH}`);
    return true;
  }
  const chain = readLedger().problem;
  if (chain) {
    log(`hours: the ledger is not pushed while its chain is broken — ${chain}`);
    return false;
  }
  const booked = readFile(unpublishedFile())?.trim() || '?';
  for (let attempt = 1; attempt <= PUSH_TRIES; attempt++) {
    const parent = await remoteHead();
    if (parent === null) {
      log(`hours: origin could not be reached — the ledger's copy waits for the next tick`);
      return false;
    }
    if (parent) {
      const theirs = await git(['show', `${parent}:${LEDGER_PATH}`]);
      const standing = compare(readFile(ledgerFile()) ?? '', theirs.ok ? theirs.out : '');
      if (standing.copy === 'diverged' || (standing.lines ?? 0) < (copyStatus().lines ?? 0)) {
        log(`hours: the ledger is not pushed over its copy — ${standing.problem ?? `the copy on ${ASSETS_BRANCH} is shorter than it was`}`);
        return false;
      }
    } else if (copyStatus().lines) {
      // A branch that held the copy and is gone was deleted: recreating it would bury that. The tick raises it.
      log(`hours: the ledger is not pushed — the copy on ${ASSETS_BRANCH} is gone, and a new branch would hide that`);
      return false;
    }
    const commit = await commitLedger(parent, `hours: run ${booked} booked`);
    if (!commit) {
      log(`hours: git could not build the ledger's commit — the copy waits for the next tick`);
      return false;
    }
    const push = await git(['push', '-q', 'origin', `${commit}:refs/heads/${ASSETS_BRANCH}`]);
    if (push.ok) {
      remove(unpublishedFile());
      log(`hours: ledger copied to ${ASSETS_BRANCH} (${booked} runs booked)`);
      return true;
    }
    if (attempt === PUSH_TRIES) log(`hours: the ledger's copy could not be pushed — ${push.err.split('\n')[0]}`);
  }
  return false;
}

/** How the branch's lines stand against the local file's. */
function compare(local: string, remote: string): CopyStatus {
  const mine = local.split('\n').filter(Boolean);
  const theirs = remote.split('\n').filter(Boolean);
  for (const [i, line] of theirs.entries()) {
    if (i >= mine.length) return { copy: 'diverged', problem: `the copy on ${ASSETS_BRANCH} has ${theirs.length - mine.length} line(s) the ledger no longer has`, lines: theirs.length };
    if (line !== mine[i]) return { copy: 'diverged', problem: `line ${i + 1} of the ledger differs from its copy on ${ASSETS_BRANCH}`, lines: theirs.length };
  }
  return { copy: theirs.length === mine.length ? 'ok' : 'behind', lines: theirs.length };
}

/** Raises `hoursTampered` once per problem, and forgets it once the record is whole again. */
async function raise(problem: string | undefined): Promise<void> {
  if (!problem) {
    remove(noticeFile());
    return;
  }
  if (readFile(noticeFile()) === problem) return;
  log(`hours: ${problem}`);
  if (isDry()) return;
  if (await notify('hoursTampered', { text: `the hours ledger cannot be trusted: ${problem}` })) write(noticeFile(), problem);
}

/**
 * The tick's step: pushes what is waiting, then compares the branch with the file — every time there was
 * something to push, and once an hour otherwise, so a quiet week costs a fetch an hour. A file whose own
 * chain is broken is raised here too, whatever the copy says. A file the push refused — broken, or diverged
 * from the branch — keeps its marker and is tried every tick: it is not pushed until a human has put the
 * record right, and the moment they have, the next tick sees it. A branch out of reach for a day is
 * raised too: an absent witness is exactly what a tamperer would arrange.
 */
export async function checkCopy(): Promise<void> {
  const pending = fs.existsSync(unpublishedFile());
  const last = copyStatus();
  const now = nowSec();
  // The status file is on the same disk as everything else: a `checkedAt` in the future would put the
  // next comparison off for ever, so it counts as no check at all.
  const recent = last.checkedAt !== undefined && last.checkedAt <= now && now - last.checkedAt < CHECK_EVERY;
  if (recent && !pending) return;
  if (pending) await publishHours();
  const local = readFile(ledgerFile()) ?? '';
  const head = await remoteHead();
  let status: CopyStatus;
  if (head === null) {
    // Since when the witness has been out of reach: an hour of it is the network, a day of it is raised.
    const since = last.copy === 'unreachable' ? Math.min(last.unreachableSince ?? now, now) : now;
    status = { copy: 'unreachable', problem: 'origin could not be reached to compare the copy', unreachableSince: since, lines: last.lines };
  } else if (head === undefined) {
    // No branch. Before the first push that is the normal state; after one it is a witness that was deleted.
    status = last.lines ? { copy: 'diverged', problem: `the copy on ${ASSETS_BRANCH} is gone — the branch held ${last.lines} line(s)`, lines: last.lines } : { copy: local ? 'behind' : 'ok', lines: 0 };
  } else {
    const shown = await git(['show', `${head}:${LEDGER_PATH}`]);
    status = compare(local, shown.ok ? shown.out : '');
    // A copy with fewer lines than it once had was rewritten — together with the local file, or `compare`
    // would have said so. What the branch once held is never forgotten.
    if (status.copy !== 'diverged' && (status.lines ?? 0) < (last.lines ?? 0)) status = { copy: 'diverged', problem: `the copy on ${ASSETS_BRANCH} held ${last.lines} line(s) and now holds ${status.lines}`, lines: last.lines };
  }
  status.checkedAt = now;
  if (!isDry()) write(statusFile(), JSON.stringify(status));
  const chain = readLedger().problem;
  const outOfReach = status.unreachableSince !== undefined && now - status.unreachableSince >= UNREACHABLE_ALARM;
  await raise(
    chain
      ? `${chain} (local file)`
      : status.copy === 'diverged'
        ? status.problem
        : outOfReach
          ? `the copy on ${ASSETS_BRANCH} has been out of reach for more than a day`
          : undefined,
  );
}
