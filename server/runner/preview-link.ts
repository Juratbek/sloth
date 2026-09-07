import path from 'node:path';
import { cfg } from '../config';
import { label } from '../repos';
import type { IssueRef } from '../repo-types';
import type { PreviewState } from '../types';
import { gh } from './gh';
import { log, readFile } from './log';
import { issueDir } from './session-dirs';

/**
 * What a preview looks like from outside the machine: the file the session wrote, the link that carries
 * the guard's key, and the one comment on the PR that is written once and edited ever after — a restart
 * re-opens the tunnel on a new address and this rewrites the same comment with it.
 */

const UPSTREAM = /^http:\/\/(localhost|127\.0\.0\.1):\d{2,5}\/?$/;
const MAX_LOGIN = 3000; // characters of the session's sign-in notes that make it into the comment

export interface PreviewFile {
  url: string;
  login?: string;
}

/** The file the session writes when it leaves its app up. */
export const fileOf = (issue: IssueRef) => path.join(issueDir(issue), 'preview.json');
/** An expiry as a comment reads it. */
export const when = (sec: number) => `${new Date(sec * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
/** The link as it is handed out: the tunnel's address plus the key the guard behind it wants. */
export const linkOf = (s: PreviewState) => `${s.url}/?sloth_key=${s.key}`;

/** What the session left behind: the one local address its app answers on, and how to sign in. */
export function readPreviewFile(issue: IssueRef): PreviewFile | undefined {
  try {
    const p = JSON.parse(readFile(fileOf(issue)) ?? '') as Partial<PreviewFile>;
    if (typeof p.url !== 'string' || !UPSTREAM.test(p.url)) return undefined;
    return { url: p.url.replace(/\/$/, ''), login: typeof p.login === 'string' ? p.login.trim().slice(0, MAX_LOGIN) : undefined };
  } catch {
    return undefined;
  }
}

export function body(s: PreviewState, p: PreviewFile): string {
  const c = cfg();
  const lines = [
    `${c.botPrefix} Preview of this PR: ${linkOf(s)}`,
    '',
    `It is the app as the session left it — its own database, seeded, nothing shared — and stays up until ` +
      `**${when(s.expiresAt)}** (${c.previewHours} h). Later pushes to the branch are not picked up. Opening the ` +
      'link leaves a cookie behind that keeps this environment open, so treat it as this PR\'s own.',
  ];
  if (p.login) lines.push('', p.login);
  return lines.join('\n');
}

/**
 * Writes the preview comment on the PR (the issue when the run opened none), or edits the one already
 * there. False when GitHub refused it: the link is the whole point of a preview, so a caller that has
 * one to hand out must not record the preview as announced on the strength of a comment that never
 * landed — `s.commentId` would be lost with it, and the "preview is gone" note at the end too.
 */
export async function post(issue: IssueRef, s: PreviewState, text: string): Promise<boolean> {
  // The PR is the session's own, opened from the issue's checkout: it is in the issue's repository.
  const r = s.commentId
    ? await gh(['api', '-X', 'PATCH', `repos/${issue.repo}/issues/comments/${s.commentId}`, '-f', `body=${text}`, '--jq', '.id'])
    : await gh(['api', `repos/${issue.repo}/issues/${s.pr ?? issue.number}/comments`, '-f', `body=${text}`, '--jq', '.id']);
  if (!r.ok) {
    log(`preview ${label(issue)}: comment failed: ${r.err.split('\n')[0]}`);
    return false;
  }
  s.commentId = Number(r.out) || s.commentId;
  return true;
}
