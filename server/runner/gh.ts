import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, type Ran } from '../exec';
import { log } from './log';

/** The runner's view of `server/exec.ts` — re-exported so every `gh` / `git` caller has one import. */
export { run } from '../exec';
export type { Ran, RunOptions } from '../exec';

/** `gh …`, retried once — the API is flaky often enough that a single retry pays for itself. */
export async function gh(args: string[], timeout = 60_000): Promise<Ran> {
  const first = await run('gh', args, { timeout });
  if (first.ok) return first;
  await new Promise((r) => setTimeout(r, 1500));
  return run('gh', args, { timeout });
}

/** A GraphQL query through `gh api graphql`; throws on transport or GraphQL errors. */
export async function graphql(query: string, variables: string[] = []): Promise<any> {
  const r = await gh(['api', 'graphql', '-f', `query=${query}`, ...variables]);
  if (!r.ok) throw new Error(r.err || 'gh api graphql failed');
  const parsed = JSON.parse(r.out);
  if (parsed.errors?.length) throw new Error(parsed.errors.map((e: { message: string }) => e.message).join('; '));
  return parsed.data;
}

/** Same, for a mutation whose variables are objects or lists — sent as a JSON body file. */
export async function graphqlBody(query: string, variables: Record<string, unknown>): Promise<any> {
  const file = path.join(os.tmpdir(), `sloth-gql-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify({ query, variables }));
  try {
    const r = await gh(['api', 'graphql', '--input', file]);
    if (!r.ok) throw new Error(r.err || 'gh api graphql failed');
    const parsed = JSON.parse(r.out);
    if (parsed.errors?.length) throw new Error(parsed.errors.map((e: { message: string }) => e.message).join('; '));
    return parsed.data;
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/** A comment written by Sloth, always prefixed so trigger 3 can skip its own words. */
export async function comment(repo: string, issue: number, body: string): Promise<boolean> {
  const r = await gh(['issue', 'comment', String(issue), '--repo', repo, '--body', body]);
  if (!r.ok) log(`#${issue} comment failed: ${r.err.split('\n')[0]}`);
  return r.ok;
}

/**
 * A reaction on a comment — the 👀 Sloth leaves on every mention it has read, so the author knows it
 * landed before any reply does. GitHub answers the same reaction twice with the one already there, so a
 * comment looked at again on a later tick (a held order, a queued reply) gets no second pair of eyes.
 */
export async function react(repo: string, commentId: number, content: 'eyes'): Promise<boolean> {
  const r = await gh(['api', `repos/${repo}/issues/comments/${commentId}/reactions`, '-f', `content=${content}`, '--jq', '.id']);
  if (!r.ok) log(`comment ${commentId}: reaction failed: ${r.err.split('\n')[0]}`);
  return r.ok;
}
