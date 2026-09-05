/**
 * The repositories the logged-in `gh` account can reach — the list the wizard's repository step and
 * Settings → *Repository* tick from — and, beside it, the way both this and `setup.ts` ask GitHub: the
 * runner's `graphql` with a message the user can act on when `gh` is not installed at all.
 */

import type { SetupRepo } from './config-types';
import { graphql as ghGraphql } from './runner/gh';

/** A failed shell-out in words the wizard's user can do something about; "ENOENT" says nothing. */
export const notFound = (err: string, cmd: string): string => (/ENOENT/.test(err) ? `\`${cmd}\` was not found on PATH` : err);

/**
 * The runner's `graphql` — the same single retry every other GitHub call gets, because the wizard reads
 * the same flaky API. Only the wording is the wizard's.
 */
export async function graphql(query: string, variables: string[] = []): Promise<any> {
  try {
    return await ghGraphql(query, variables);
  } catch (e) {
    throw new Error(notFound(e instanceof Error ? e.message : String(e), 'gh'));
  }
}

const AFFILIATIONS = '[OWNER, COLLABORATOR, ORGANIZATION_MEMBER]';
const REPOS_QUERY = `query($after: String) {
  viewer {
    repositories(first: 100, after: $after, affiliations: ${AFFILIATIONS}, ownerAffiliations: ${AFFILIATIONS}, orderBy: { field: PUSHED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { nameWithOwner description isPrivate isArchived viewerPermission pushedAt }
    }
  }
}`;

/** How many pages of a hundred are read before the list is called long enough to pick from. */
const MAX_PAGES = 10;

const PERMISSIONS: SetupRepo['permission'][] = ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'];

interface RawRepo {
  nameWithOwner?: string;
  description?: string | null;
  isPrivate?: boolean;
  isArchived?: boolean;
  viewerPermission?: string | null;
  pushedAt?: string | null;
}

const shape = (r: RawRepo): SetupRepo => ({
  slug: r.nameWithOwner ?? '',
  description: r.description ?? '',
  private: !!r.isPrivate,
  archived: !!r.isArchived,
  // A permission GitHub does not name is read as the least of them: a repository is never offered on a guess.
  permission: PERMISSIONS.find((p) => p === r.viewerPermission) ?? 'READ',
  pushedAt: r.pushedAt ?? '',
});

/** Last pushed first, and everything archived after everything that is not. */
const byRecency = (a: SetupRepo, b: SetupRepo) => Number(a.archived) - Number(b.archived) || b.pushedAt.localeCompare(a.pushedAt);

/**
 * Every repository the account owns, collaborates on or is in the organization of, newest push first.
 * Read a page of a hundred at a time up to a thousand — past that the search box is the way to a
 * repository, and the picker takes a name typed in by hand for anything it did not read.
 */
export async function accessibleRepos(): Promise<SetupRepo[]> {
  const raw: RawRepo[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    // The first page asks for none: `$after` left out is null, which is where the connection starts.
    const data = await graphql(REPOS_QUERY, after ? ['-F', `after=${after}`] : []);
    const connection = data?.viewer?.repositories;
    raw.push(...((connection?.nodes ?? []) as RawRepo[]).filter(Boolean));
    const next = connection?.pageInfo;
    if (!next?.hasNextPage || !next.endCursor) break;
    after = String(next.endCursor);
  }
  const seen = new Set<string>();
  return raw
    .map(shape)
    .filter((r) => r.slug && !seen.has(r.slug.toLowerCase()) && seen.add(r.slug.toLowerCase()))
    .sort(byRecency);
}
