import { useState, type ReactNode } from 'react';
import type { RepoConfig, SetupRepo } from '../../server/config-types';
import { Button, Error, Loading, TextInput, inputStyle } from './ui';
import { REPO_RE, newRepo, useAccessibleRepos } from './use-setup';

/**
 * Which repositories Sloth may work in, ticked off the list of everything the logged-in `gh` account can
 * reach. The wizard's repository step and Settings → *Repositories* show the same one, so a repository is
 * added the same way whichever page the user is on. Selection order is kept: the first repository is
 * where a run with no card of its own — the smoke test, the stack install — works. A picked row opens on
 * whatever the page gives `details` — its checkout, its note — so the options are read where the tick is.
 */

/** Sloth pushes branches and opens PRs, so reading a repository is not enough to be given it. */
const canWrite = (permission: SetupRepo['permission']) => permission !== 'READ' && permission !== 'TRIAGE';

interface Row {
  slug: string;
  description: string;
  private: boolean;
  archived: boolean;
  writable: boolean;
  /** A picked repository the read list does not hold — access lost, or past the thousand. Never while the list is still unread. */
  missing: boolean;
}

const rowOf = (repo: SetupRepo): Row => ({ slug: repo.slug, description: repo.description, private: repo.private, archived: repo.archived, writable: canWrite(repo.permission), missing: false });
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * The picked first (in the order they were picked), then the board's own, then the rest as the server
 * sent them. `read` is whether the list has come back at all: until it has, a picked repository is not
 * missing from anything, it is only waiting, and saying otherwise reads as bad news that is not there.
 */
function ordered(listed: SetupRepo[], picked: RepoConfig[], linked: string[], read: boolean): Row[] {
  const byslug = new Map(listed.map((r) => [r.slug.toLowerCase(), r]));
  const taken = new Set<string>();
  const rows: Row[] = [];
  const push = (row: Row) => {
    if (taken.has(row.slug.toLowerCase())) return;
    taken.add(row.slug.toLowerCase());
    rows.push(row);
  };
  for (const { slug } of picked) {
    const listing = byslug.get(slug.toLowerCase());
    push(listing ? rowOf(listing) : { slug, description: '', private: false, archived: false, writable: true, missing: read });
  }
  for (const slug of linked) {
    const listing = byslug.get(slug.toLowerCase());
    if (listing) push(rowOf(listing));
  }
  for (const listing of listed) push(rowOf(listing));
  return rows;
}

const matches = (row: Row, filter: string) => `${row.slug} ${row.description}`.toLowerCase().includes(filter);

const Badge = ({ children }: { children: string }) => <span className="shrink-0 rounded border border-edge px-1 text-[10px] text-fg-faint">{children}</span>;

/** Why a row cannot be ticked, or why it is on the list at all when GitHub did not name it. */
function hintFor(row: Row, locked: boolean): string {
  if (!row.writable) return 'read access only — Sloth pushes branches and opens PRs';
  if (locked) return 'the first repository this Sloth watched — its files on disk carry no repository name, so it cannot be removed';
  return row.missing ? 'not in your list' : '';
}

function RepoRow({ row, picked, linked, locked, onToggle, details }: { row: Row; picked: boolean; linked: boolean; locked: boolean; onToggle: () => void; details?: ReactNode }) {
  const disabled = locked || (!row.writable && !picked);
  const hint = hintFor(row, locked);
  return (
    <div className={`rounded-md border ${picked ? 'border-ok-edge-strong bg-ok-tint/30' : 'border-edge hover:bg-surface-raised'} ${!row.writable && !picked ? 'opacity-60' : ''}`}>
      <label className="flex items-start gap-2 px-3 py-2">
        <input
          type="checkbox"
          checked={picked}
          disabled={disabled}
          aria-label={row.slug}
          onChange={onToggle}
          className="mt-0.5 h-4 w-4 shrink-0 accent-accent disabled:opacity-40"
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-sm text-fg-strong">{row.slug}</span>
            {linked && <Badge>linked to the board</Badge>}
            {row.private && <Badge>private</Badge>}
            {row.archived && <Badge>archived</Badge>}
          </span>
          {row.description && <span className="block truncate text-xs text-fg-muted">{row.description}</span>}
          {hint && <span className="block text-[11px] text-fg-faint">{hint}</span>}
        </span>
      </label>
      {picked && details && <div className="border-t border-edge px-3 pt-3 pb-3">{details}</div>}
    </div>
  );
}

/** The name typed in for a repository the list has not got — kept, but out of the way of the ticking. */
function AddByName({ onAdd, taken }: { onAdd: (slug: string) => void; taken: (slug: string) => boolean }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const slug = typed.trim();
  const add = () => {
    if (!REPO_RE.test(slug) || taken(slug)) return;
    onAdd(slug);
    setTyped('');
  };
  if (!open)
    return (
      <button type="button" onClick={() => setOpen(true)} className="text-[11px] text-fg-faint underline underline-offset-2 hover:text-fg-muted">
        Not in the list? Add by name
      </button>
    );
  return (
    <div className="flex gap-2">
      <TextInput value={typed} onChange={setTyped} placeholder="owner/repo" />
      <Button disabled={!REPO_RE.test(slug) || taken(slug)} onClick={add}>
        Add
      </Button>
    </div>
  );
}

const messageOf = (e: unknown) => (e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : String(e));

/** A failed reading that is really the `gh` behind it: not installed, or installed and signed in to nobody. */
const isLogin = (message: string) => /not logged in|was not found on PATH|authentication|credentials/i.test(message);

export default function RepoPicker({
  repos,
  onChange,
  linked,
  home,
  locked,
  details,
  bounded,
}: {
  repos: RepoConfig[];
  onChange: (repos: RepoConfig[]) => void;
  linked: string[];
  home: string;
  /** A slug that stays ticked whatever the user does — the repository whose files on disk carry no name. */
  locked?: string;
  /** What a picked row opens on, inside its own card: the checkout, the note, whatever the page adds. */
  details?: (repo: RepoConfig, index: number) => ReactNode;
  /** Keeps the list in its own scroll box — for the wizard, where the step sits in a dialog-like flow. */
  bounded?: boolean;
}) {
  const { data, error, isFetching } = useAccessibleRepos();
  const [filter, setFilter] = useState('');

  const at = (slug: string) => repos.findIndex((r) => same(r.slug, slug));
  const toggle = (slug: string) => onChange(at(slug) >= 0 ? repos.filter((r) => !same(r.slug, slug)) : [...repos, newRepo(slug, home)]);
  const rows = ordered(data ?? [], repos, linked, !!data);
  const needle = filter.trim().toLowerCase();
  const shown = needle ? rows.filter((row) => matches(row, needle)) : rows;
  const message = error ? messageOf(error) : '';

  return (
    <div className="space-y-2">
      <input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Search repositories"
        aria-label="Search repositories"
        spellCheck={false}
        className={inputStyle}
      />
      {message && (
        <>
          <Error>{message}</Error>
          {isLogin(message) && <p className="text-xs text-fg-muted">Install gh and log in to GitHub first — the wizard's first step does both.</p>}
        </>
      )}
      {!data && isFetching && <Loading what="repositories" />}
      {data && rows.length === 0 && !needle && <p className="text-sm text-fg-muted">This GitHub account can reach no repositories.</p>}
      <div className={`space-y-1.5 ${bounded ? 'max-h-[46vh] overflow-y-auto pr-1' : ''}`}>
        {shown.map((row) => {
          const index = at(row.slug);
          return (
            <RepoRow
              key={row.slug}
              row={row}
              picked={index >= 0}
              linked={linked.some((l) => same(l, row.slug))}
              locked={!!locked && same(locked, row.slug)}
              onToggle={() => toggle(row.slug)}
              details={index >= 0 && details ? details(repos[index], index) : undefined}
            />
          );
        })}
      </div>
      {needle && (
        <p className="text-[11px] text-fg-faint">
          {shown.length} of {rows.length} shown
        </p>
      )}
      <AddByName onAdd={(slug) => onChange([...repos, newRepo(slug, home)])} taken={(slug) => at(slug) >= 0} />
    </div>
  );
}
