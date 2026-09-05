/**
 * The repositories Sloth works in, and how one is named in a file or a path. Pure — the UI imports it
 * beside the config types. `repos.ts` is the server's side: which of them is which, where its checkout is.
 */

/** One repository Sloth may work in: its `owner/name`, a line saying what it is, and its checkout. */
export interface RepoConfig {
  slug: string;
  /** What this repository is, in the user's words — what the choice of a repository for a card is made on. */
  note: string;
  /** The checkout the sessions of this repository run from; Sloth clones it there itself. */
  root: string;
}

/** `owner/repo`, constrained to the characters GitHub allows — it flows into shell argv, URLs and file names. */
export const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

/** The part after the slash. */
export const repoName = (slug: string): string => slug.split('/')[1] ?? slug;

/**
 * A repository as a file or directory name carries it: `owner~name`. `~` is a character GitHub never
 * allows in a login or a repository name, so the key splits back without ambiguity, and it is safe in a
 * path on every platform.
 */
export const repoKey = (slug: string): string => slug.replace('/', '~');
export const slugOfKey = (key: string): string => key.replace('~', '/');
const KEY_RE = /^(.*)@([\w.-]+~[\w.-]+)$/;

/**
 * A name tagged with the repository it belongs to — `issue-12@acme~widgets`. `legacy` is the one
 * repository whose names carry no tag: the files an older Sloth wrote for its single repository keep
 * their names, so nothing on disk has to move when a second repository is added.
 */
export const sameSlug = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
export const tagged = (base: string, slug: string, legacy: string): string => (sameSlug(slug, legacy) ? base : `${base}@${repoKey(slug)}`);

/** `tagged` read backwards: the base name and the repository — the legacy one when the name carries no tag. */
export function untag(name: string, legacy: string): { base: string; repo: string } {
  const m = KEY_RE.exec(name);
  return m ? { base: m[1], repo: slugOfKey(m[2]) } : { base: name, repo: legacy };
}

/** A GitHub issue or PR, named by its repository and its number — the one identity every card, run and marker is keyed on. */
export interface IssueRef {
  repo: string;
  number: number;
}
export type PrRef = IssueRef;

/** A map key for a ref — `owner/name#12`. */
export const refKey = (r: IssueRef): string => `${r.repo}#${r.number}`;

export const issueUrl = (r: IssueRef): string => `https://github.com/${r.repo}/issues/${r.number}`;
export const prUrl = (r: PrRef): string => `https://github.com/${r.repo}/pull/${r.number}`;
export const repoUrl = (slug: string): string => `https://github.com/${slug}`;

/**
 * How an issue reads in a log line or a label: `#12` while Sloth watches one repository, `widgets#12`
 * once it watches several — the number alone would not say which.
 */
export const issueLabel = (r: IssueRef, several: boolean): string => (several ? `${repoName(r.repo)}#${r.number}` : `#${r.number}`);
