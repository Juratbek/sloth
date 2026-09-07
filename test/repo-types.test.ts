import { describe, expect, it } from 'vitest';
import { legacyRepoOf, reposOf } from '../server/config-repos';
import { REPO_RE, issueLabel, refKey, repoKey, slugOfKey, tagged, untag } from '../server/repo-types';

/**
 * How a repository is named in a file or a path, and how a saved config's repositories are read: the
 * two pure halves everything keyed on "repository and number" rests on.
 */

describe('tagged names', () => {
  it('leaves the legacy repository’s names alone and tags every other with @owner~name', () => {
    expect(tagged('issue-12', 'acme/widgets', 'acme/widgets')).toBe('issue-12');
    expect(tagged('issue-12', 'acme/api', 'acme/widgets')).toBe('issue-12@acme~api');
    expect(tagged('30-abc', 'acme/api', '')).toBe('30-abc@acme~api');
  });

  it('reads a tagged name back, and an untagged one as the legacy repository’s', () => {
    expect(untag('issue-12@acme~api', 'acme/widgets')).toEqual({ base: 'issue-12', repo: 'acme/api' });
    expect(untag('issue-12', 'acme/widgets')).toEqual({ base: 'issue-12', repo: 'acme/widgets' });
    // A base with `@` or `~` in it is not a tag: only `@owner~name` at the very end is.
    expect(untag('slot-1@acme~my.repo-2', 'x/y')).toEqual({ base: 'slot-1', repo: 'acme/my.repo-2' });
    expect(untag('42-abc@notatag', 'x/y')).toEqual({ base: '42-abc@notatag', repo: 'x/y' });
  });

  it('round-trips every slug GitHub allows through the key', () => {
    for (const slug of ['acme/widgets', 'my-org/my.repo_2', 'A/b']) {
      expect(slugOfKey(repoKey(slug))).toBe(slug);
      expect(REPO_RE.test(slug)).toBe(true);
      expect(untag(tagged('issue-1', slug, ''), '')).toEqual({ base: 'issue-1', repo: slug });
    }
    expect(REPO_RE.test('acme')).toBe(false);
    expect(REPO_RE.test('acme/wid gets')).toBe(false);
  });

  it('labels an issue by number alone with one repository and by name once there are several', () => {
    const ref = { repo: 'acme/widgets', number: 12 };
    expect(issueLabel(ref, false)).toBe('#12');
    expect(issueLabel(ref, true)).toBe('widgets#12');
    expect(refKey(ref)).toBe('acme/widgets#12');
  });
});

describe('reposOf', () => {
  it('reads an older config’s single repo and runnerRoot as a list of one, its checkout where it was', () => {
    expect(reposOf(undefined, 'acme/widgets', '/srv/widgets', '/home/x/.sloth/runners')).toEqual([{ slug: 'acme/widgets', note: '', root: '/srv/widgets' }]);
  });

  it('takes a list of slugs or entries, drops a duplicate, trims the note to one line, defaults the root', () => {
    const list = reposOf(['acme/widgets', { slug: 'acme/api', note: ' the API\nsecond line ', root: '~/code/api' }, { repo: 'ACME/widgets' }], undefined, undefined, '/r');
    expect(list).toEqual([
      { slug: 'acme/widgets', note: '', root: '/r/widgets' },
      { slug: 'acme/api', note: 'the API', root: expect.stringMatching(/\/code\/api$/) },
    ]);
  });

  it('refuses an empty list, a bad slug, and two repositories sharing one checkout', () => {
    expect(() => reposOf([], undefined, undefined, '/r')).toThrow(/at least one repository/);
    expect(() => reposOf(undefined, undefined, undefined, '/r')).toThrow(/at least one repository/);
    expect(() => reposOf(['widgets'], undefined, undefined, '/r')).toThrow(/owner\/repo/);
    expect(() => reposOf([{ slug: 'a/x', root: '/same' }, { slug: 'b/y', root: '/same' }], undefined, undefined, '/r')).toThrow(/share the checkout/);
  });
});

describe('legacyRepoOf', () => {
  const repos = reposOf(['acme/widgets', 'acme/api'], undefined, undefined, '/r');
  it('keeps what was saved, takes the migrated repo, and settles on the first repository for a new config', () => {
    expect(legacyRepoOf('acme/api', repos, undefined)).toBe('acme/api');
    expect(legacyRepoOf(undefined, repos, 'acme/api')).toBe('acme/api');
    expect(legacyRepoOf(undefined, repos, 'acme/gone')).toBe('acme/widgets');
    expect(legacyRepoOf('', repos, undefined)).toBe('acme/widgets');
  });
});
