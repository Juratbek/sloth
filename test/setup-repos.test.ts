import { beforeEach, describe, expect, it, vi } from 'vitest';
import { accessibleRepos } from '../server/setup-repos';
import { calls, fail, onGh, resetGh } from './gh-mock';

vi.mock('../server/runner/gh', () => import('./gh-mock'));

/**
 * The list the repository picker ticks from: every repository the logged-in account can reach, read a
 * page at a time. What the picker shows a user hangs on this being complete and in one order — a
 * repository missing from it can still be typed in by hand, but nobody thinks to look for it.
 */

interface Node {
  nameWithOwner: string;
  description?: string | null;
  isPrivate?: boolean;
  isArchived?: boolean;
  viewerPermission?: string | null;
  pushedAt?: string;
}

const page = (nodes: Node[], endCursor?: string) => ({
  viewer: { repositories: { pageInfo: { hasNextPage: !!endCursor, endCursor: endCursor ?? null }, nodes } },
});

const node = (nameWithOwner: string, over: Partial<Node> = {}): Node => ({
  nameWithOwner,
  description: 'a repository',
  isPrivate: false,
  isArchived: false,
  viewerPermission: 'WRITE',
  pushedAt: '2026-09-01T00:00:00Z',
  ...over,
});

/** The `-F after=…` of each call, in order — `undefined` where the call asked for the first page. */
const cursors = () => calls.map((c) => /after=(\S+)/.exec(c.line)?.[1]);

beforeEach(resetGh);

describe('the repositories the account can reach', () => {
  it('follows the cursor to the next page and joins the two, asking for no cursor first', async () => {
    onGh(/repositories\(first: 100/, (call) => (/after=/.test(call.line) ? page([node('acme/api')]) : page([node('acme/widgets')], 'CURSOR_1')));
    const repos = await accessibleRepos();
    expect(repos.map((r) => r.slug)).toEqual(['acme/widgets', 'acme/api']);
    expect(cursors()).toEqual([undefined, 'CURSOR_1']);
  });

  it('stops at the last page', async () => {
    onGh(/repositories\(first: 100/, page([node('acme/widgets')]));
    expect(await accessibleRepos()).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it('keeps one row per repository, however the pages spell it', async () => {
    onGh(/repositories\(first: 100/, (call) => (/after=/.test(call.line) ? page([node('Acme/Widgets'), node('acme/api')]) : page([node('acme/widgets')], 'CURSOR_1')));
    expect((await accessibleRepos()).map((r) => r.slug)).toEqual(['acme/widgets', 'acme/api']);
  });

  it('puts the last push first and everything archived after everything that is not', async () => {
    onGh(
      /repositories\(first: 100/,
      page([
        node('acme/old', { pushedAt: '2024-01-01T00:00:00Z' }),
        node('acme/attic', { isArchived: true, pushedAt: '2026-09-04T00:00:00Z' }),
        node('acme/new', { pushedAt: '2026-09-03T00:00:00Z' }),
      ]),
    );
    expect((await accessibleRepos()).map((r) => r.slug)).toEqual(['acme/new', 'acme/old', 'acme/attic']);
  });

  it('reads a repository with no description as one with an empty one, and an unknown permission as the least', async () => {
    onGh(/repositories\(first: 100/, page([node('acme/widgets', { description: null, viewerPermission: null, isPrivate: true })]));
    const [repo] = await accessibleRepos();
    expect(repo).toMatchObject({ slug: 'acme/widgets', description: '', permission: 'READ', private: true, archived: false });
  });

  it('stops reading pages at a thousand repositories — the search box is the way past that', async () => {
    let n = 0;
    onGh(/repositories\(first: 100/, () => page([node(`acme/repo-${(n += 1)}`)], `CURSOR_${n}`));
    expect(await accessibleRepos()).toHaveLength(10);
    expect(calls).toHaveLength(10);
  });

  it('hands the picker what GitHub refused with, rather than an empty list', async () => {
    onGh(/repositories\(first: 100/, fail('HTTP 403: Resource not accessible by personal access token'));
    await expect(accessibleRepos()).rejects.toThrow(/403/);
  });

  it('says gh is not installed when gh is what is missing', async () => {
    onGh(/repositories\(first: 100/, fail('Error: spawn gh ENOENT'));
    await expect(accessibleRepos()).rejects.toThrow('`gh` was not found on PATH');
  });
});
