import type { RepoConfig, SetupRepo } from '../../server/config-types';

/**
 * What the picker shows and in what order. The order is the list's own, not the user's: the board's
 * repositories first, then everything else as the server sent it (newest push first, archived last), so
 * that ticking a repository leaves it exactly where the eye found it. Only a picked repository the list
 * does not hold has nowhere of its own and goes to the end.
 */

export const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Sloth pushes branches and opens PRs, so reading a repository is not enough to be given it. */
export const canWrite = (permission: SetupRepo['permission']) => permission !== 'READ' && permission !== 'TRIAGE';

export interface ListRow {
  slug: string;
  description: string;
  private: boolean;
  archived: boolean;
  writable: boolean;
  /** A picked repository the read list does not hold — access lost, or past the thousand. Never while the list is still unread. */
  missing: boolean;
}

export const rowOf = (repo: SetupRepo): ListRow => ({
  slug: repo.slug,
  description: repo.description,
  private: repo.private,
  archived: repo.archived,
  writable: canWrite(repo.permission),
  missing: false,
});

/** Which repositories the "All repositories" switch covers: the ones Sloth could actually work in. */
export const grantable = (listed: SetupRepo[]) => listed.filter((r) => canWrite(r.permission) && !r.archived);

/**
 * The board's own repositories first, then the rest as the server sent them, and last the picked ones
 * the list has not got. A row keeps its place when it is ticked or unticked — the list never reorders
 * under the user's hand. `read` is whether the list has come back at all: until it has, a picked
 * repository is not missing from anything, it is only waiting, and saying otherwise reads as bad news
 * that is not there.
 */
export function ordered(listed: SetupRepo[], picked: RepoConfig[], linked: string[], read: boolean): ListRow[] {
  const byslug = new Map(listed.map((r) => [r.slug.toLowerCase(), r]));
  const taken = new Set<string>();
  const rows: ListRow[] = [];
  const push = (row: ListRow) => {
    if (taken.has(row.slug.toLowerCase())) return;
    taken.add(row.slug.toLowerCase());
    rows.push(row);
  };
  for (const slug of linked) {
    const listing = byslug.get(slug.toLowerCase());
    if (listing) push(rowOf(listing));
  }
  for (const listing of listed) push(rowOf(listing));
  for (const { slug } of picked) {
    if (!byslug.has(slug.toLowerCase())) push({ slug, description: '', private: false, archived: false, writable: true, missing: read });
  }
  return rows;
}

/** All of them, only the ticked ones, or only the rest — the segmented control beside the search. */
export type Status = 'all' | 'picked' | 'unpicked';
export const STATUSES: { key: Status; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'picked', label: 'Selected' },
  { key: 'unpicked', label: 'Not selected' },
];

const matchesText = (row: ListRow, needle: string) => `${row.slug} ${row.description}`.toLowerCase().includes(needle);

export const filtered = (rows: ListRow[], needle: string, status: Status, isPicked: (slug: string) => boolean) =>
  rows.filter(
    (row) =>
      (!needle || matchesText(row, needle)) && (status === 'all' || (status === 'picked') === isPicked(row.slug)),
  );
