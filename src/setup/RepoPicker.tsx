import { useState, type ReactNode } from 'react';
import type { RepoConfig } from '../../server/config-types';
import { Toggle } from '../settings/ui';
import RepoRow from './RepoRow';
import { STATUSES, filtered, grantable, ordered, same, type Status } from './pick-order';
import { Button, Error, Loading, TextInput, inputStyle } from './ui';
import { REPO_RE, newRepo, useAccessibleRepos } from './use-setup';

/**
 * Which repositories Sloth may work in, ticked off the list of everything the logged-in `gh` account can
 * reach. The wizard's repository step and Settings → *Repositories* show the same one, so a repository is
 * added the same way whichever page the user is on. The list keeps the order it was read in — ticking
 * moves nothing — and the config's own order is what says which repository is first, the one a run with
 * no card of its own works in. A picked row opens on whatever the page gives `details` — its checkout,
 * its note — so the options are read where the tick is, and folds away again behind its chevron. The
 * search, the Selected/Not selected filter and the all-repositories switch stay at the top of the list.
 */

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

function StatusFilter({ status, onStatus }: { status: Status; onStatus: (s: Status) => void }) {
  return (
    <div className="flex shrink-0 items-center gap-0.5 rounded-md border border-edge p-0.5">
      {STATUSES.map(({ key, label }) => (
        <button
          key={key}
          type="button"
          aria-pressed={status === key}
          onClick={() => onStatus(key)}
          className={`rounded px-2 py-1 text-xs ${status === key ? 'bg-surface-raised text-fg-strong' : 'text-fg-muted hover:text-fg-soft'}`}
        >
          {label}
        </button>
      ))}
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
  const [status, setStatus] = useState<Status>('all');
  // Folded away, not opened: a picked repository is worth reading in full the moment it is picked, so the
  // set holds what the user has shut rather than what is open, and a newly ticked repository is in neither.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const fold = (slug: string) =>
    setCollapsed((shut) => {
      const next = new Set(shut);
      if (!next.delete(slug.toLowerCase())) next.add(slug.toLowerCase());
      return next;
    });

  const at = (slug: string) => repos.findIndex((r) => same(r.slug, slug));
  const picked = (slug: string) => at(slug) >= 0;
  const toggle = (slug: string) => onChange(picked(slug) ? repos.filter((r) => !same(r.slug, slug)) : [...repos, newRepo(slug, home)]);
  const rows = ordered(data ?? [], repos, linked, !!data);
  const needle = filter.trim().toLowerCase();
  const shown = filtered(rows, needle, status, picked);
  const message = error ? messageOf(error) : '';

  // Derived, never saved: "all" is true when nothing writable is left out, and turning it off leaves the
  // locked repository behind — the files on disk carry its name, so it is not the user's to drop.
  const all = grantable(data ?? []);
  const allPicked = all.length > 0 && all.every((r) => picked(r.slug));
  const setAll = (on: boolean) =>
    onChange(on ? [...repos, ...all.filter((r) => !picked(r.slug)).map((r) => newRepo(r.slug, home))] : repos.filter((r) => !!locked && same(r.slug, locked)));

  return (
    <div className="space-y-2">
      <div className="sticky top-0 z-10 -mt-2 flex flex-wrap items-center gap-2 bg-surface py-2">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search repositories"
          aria-label="Search repositories"
          spellCheck={false}
          className={`${inputStyle} min-w-48 flex-1`}
        />
        <StatusFilter status={status} onStatus={setStatus} />
        <span className="flex shrink-0 items-center gap-2 pl-1 text-xs text-fg-muted" title="Sloth may work in every repository this account can write to">
          <Toggle checked={allPicked} onChange={setAll} label="All repositories" disabled={!data || !!error} />
          All repositories
        </span>
      </div>
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
              open={!collapsed.has(row.slug.toLowerCase())}
              onOpen={() => fold(row.slug)}
              checkout={index >= 0 ? repos[index].root : undefined}
            />
          );
        })}
      </div>
      {(needle || status !== 'all') && (
        <p className="text-[11px] text-fg-faint">
          {shown.length} of {rows.length} shown
        </p>
      )}
      <AddByName onAdd={(slug) => onChange([...repos, newRepo(slug, home)])} taken={picked} />
    </div>
  );
}
