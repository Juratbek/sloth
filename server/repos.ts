import path from 'node:path';
import { cfg, transcriptsDirOf } from './config';
import { defaultRepoRoot } from './config-repos';
import { issueLabel, sameSlug, tagged, untag, type IssueRef, type RepoConfig } from './repo-types';
import fs from 'node:fs';

/**
 * The repositories as the server sees them: which are configured, where each one's checkout is, which
 * one the untagged files belong to, and how a name is tagged with its repository. Everything that keys a
 * file on an issue, a PR or a slot goes through `tag` / `untagName`, so the naming rule lives here once.
 */

export const repos = (): RepoConfig[] => cfg().repos;
export const repoSlugs = (): string[] => repos().map((r) => r.slug);
/** GitHub reads `Acme/Widgets` and `acme/widgets` as one repository, so Sloth does too: a lookup by slug ignores case. */
export const repoOf = (slug: string): RepoConfig | undefined => repos().find((r) => sameSlug(r.slug, slug));
export const isConfigured = (slug: string): boolean => !!repoOf(slug);
/** The slug as the config spells it — the spelling every file name and key is under — or nothing for a repository that is not Sloth's. */
export const canonicalRepo = (slug: string): string | undefined => repoOf(slug)?.slug;
/** The first repository: where a run with no card of its own — the smoke test, the stack install — works. */
export const primaryRepo = (): string => repos()[0]?.slug ?? '';
/** The repository whose names carry no tag — the one an older config named (`config-repos.ts`). */
export const legacyRepo = (): string => cfg().legacyRepo;
/** Whether the log has to say which repository an issue is in. */
export const several = (): boolean => repos().length > 1;

/** A repository's checkout. One no longer configured still has a place, so its leftovers can be swept. */
export const repoRoot = (slug: string): string => repoOf(slug)?.root ?? path.resolve(defaultRepoRoot(cfg().runnersDir, slug));

/** Every repository's transcripts directory, once each — two checkouts can only share one by sharing a path. */
export const transcriptsDirs = (): string[] => [...new Set(repos().map((r) => transcriptsDirOf(r.root)))];
/** Where Claude Code writes the transcripts of a repository's sessions: under the checkout they run in. */
export const transcriptsDirOfRepo = (slug: string): string => transcriptsDirOf(repoRoot(slug));
/** The repository whose sessions' transcripts land in `dir`, if it is one of Sloth's. */
export const repoOfTranscriptsDir = (dir: string): string | undefined => repos().find((r) => transcriptsDirOf(r.root) === dir)?.slug;
/** A transcript by session id, wherever it is: the directory of the repository that ran it, else the first one that has it. */
export function transcriptFile(id: string, repo?: string): string {
  if (repo) return path.join(transcriptsDirOfRepo(repo), `${id}.jsonl`);
  for (const dir of transcriptsDirs()) if (fs.existsSync(path.join(dir, `${id}.jsonl`))) return path.join(dir, `${id}.jsonl`);
  return path.join(transcriptsDirs()[0] ?? transcriptsDirOf(process.cwd()), `${id}.jsonl`);
}

export const tag = (base: string, slug: string): string => tagged(base, slug, legacyRepo());
export const untagName = (name: string): { base: string; repo: string } => untag(name, legacyRepo());

/** `#12`, or `widgets#12` once several repositories are watched. */
export const label = (r: IssueRef): string => issueLabel(r, several());
export const ref = (repo: string, number: number): IssueRef => ({ repo, number });
