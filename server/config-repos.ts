import { expandPath } from './env';
import { REPO_RE, repoName, type RepoConfig } from './repo-types';

/**
 * The `repos` half of a saved config: the list the wizard's picker wrote, or the single `repo` an older
 * config named, each with its note and its checkout. Split out of `config-file.ts`, which validates the rest.
 */

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** `owner/repo`, or a thrown reason — the slug goes into shell argv, URLs and file names. */
export function repoSlug(v: unknown): string {
  const r = text(v);
  if (!r) throw new Error('repo is required');
  if (!REPO_RE.test(r)) throw new Error('repo must be owner/repo');
  return r;
}

/** Where a repository's checkout goes when the config names none: under the runners directory, by name. */
export const defaultRepoRoot = (runnersDir: string, slug: string): string => `${runnersDir}/${repoName(slug)}`;

/**
 * The repositories, validated. A config from before there were several has `repo` and `runnerRoot`, and
 * loads as a list of one — its checkout where it always was. A slug listed twice is kept once; a note is
 * one line, trimmed; a root is expanded like every other path. An empty list is no configuration at all.
 */
export function reposOf(list: unknown, legacyRepo: unknown, legacyRoot: unknown, runnersDir: string): RepoConfig[] {
  const raw: unknown[] = Array.isArray(list) ? list : text(legacyRepo) ? [{ slug: legacyRepo, root: legacyRoot }] : [];
  const out: RepoConfig[] = [];
  for (const entry of raw) {
    const e = (typeof entry === 'string' ? { slug: entry } : (entry ?? {})) as Record<string, unknown>;
    const slug = repoSlug(e.slug ?? e.repo);
    if (out.some((r) => r.slug.toLowerCase() === slug.toLowerCase())) continue;
    out.push({
      slug,
      note: (text(e.note) ?? '').split('\n')[0].slice(0, 300),
      root: expandPath(text(e.root) ?? defaultRepoRoot(runnersDir, slug)),
    });
  }
  if (!out.length) throw new Error('repos: at least one repository is required');
  const roots = new Set<string>();
  for (const r of out) {
    if (roots.has(r.root)) throw new Error(`repos: two repositories share the checkout ${r.root}`);
    roots.add(r.root);
  }
  return out;
}

/**
 * The one repository whose files carry no repository tag (`repo-types.ts` `tagged`). A config that was
 * migrated from a single `repo` names it — that is the repository every existing session directory and
 * marker belongs to. A config the picker wrote keeps what it saved; the first time it is saved, the first
 * repository is it, so a Sloth watching one repository has the plain names it always had. Once written it
 * never changes: the files on disk were named under it.
 */
export function legacyRepoOf(saved: unknown, repos: RepoConfig[], legacyRepo: unknown): string {
  const kept = text(saved);
  if (kept) return kept;
  const slug = text(legacyRepo);
  return slug && repos.some((r) => r.slug === slug) ? slug : repos[0].slug;
}
