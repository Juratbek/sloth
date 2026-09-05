import { useState } from 'react';
import { defaultDirs } from '../../server/config-types';
import type { RepoConfig, SlothConfig } from '../../server/config-types';
import { Button, TextInput, inputStyle } from '../setup/ui';
import { REPO_RE, newRepo, useClone, useProjectFields, useSetupEnv } from '../setup/use-setup';
import { Row } from './ui';
import type { SectionProps } from './ui';

type DirKey = keyof ReturnType<typeof defaultDirs>;
const repoName = (repo: string) => repo.split('/')[1] ?? '';

const DIRS: { key: keyof SlothConfig & string; label: string; hint: string }[] = [
  { key: 'runnersDir', label: 'Runners directory', hint: 'Where a repository is cloned when its checkout is left to the default: <runners>/<name>.' },
  { key: 'worktreesDir', label: 'Worktrees directory', hint: 'The pool of worktrees the runs work in — slot-1 … slot-N under it, one per active session and one per repository in each slot, kept so their installed dependencies carry over.' },
  { key: 'sessionsDir', label: 'Sessions directory', hint: "Each run's directory — its pid, state, inbox, log, preview." },
  { key: 'stateDir', label: 'State directory', hint: 'Dedupe markers (seen, reviewed, approved, notified), the pause flag, the remote-access secret.' },
  { key: 'watcherLog', label: 'Watcher log', hint: 'One line per event — the log the home panel tails.' },
];

/** One repository's row: its slug, what it is, where its checkout is, and a button to clone it now. */
function RepoRow({ repo, several, linked, onChange, onRemove }: { repo: RepoConfig; several: boolean; linked: string[]; onChange: (r: RepoConfig) => void; onRemove?: () => void }) {
  const clone = useClone();
  const ok = REPO_RE.test(repo.slug);
  return (
    <div className="space-y-2 rounded-md border border-edge p-3">
      <div className="flex items-center gap-2">
        <input
          list="linked-repos"
          value={repo.slug}
          onChange={(e) => onChange({ ...repo, slug: e.target.value })}
          placeholder="owner/repo"
          spellCheck={false}
          aria-label="Repository"
          className={inputStyle}
        />
        {onRemove && (
          <Button onClick={onRemove} aria-label={`Remove ${repo.slug || 'repository'}`}>
            Remove
          </Button>
        )}
      </div>
      {!ok && repo.slug && <p className="text-xs text-red-400">A repository is owner/repo.</p>}
      {several && (
        <TextInput value={repo.note} onChange={(note) => onChange({ ...repo, note })} placeholder="What it is, in one line — a card that names no repository is placed by this" />
      )}
      <div className="flex w-full gap-2">
        <TextInput value={repo.root} onChange={(root) => onChange({ ...repo, root })} placeholder={`~/.sloth/runners/${repoName(repo.slug) || 'repo'}`} />
        <Button disabled={!ok || !repo.root || clone.isPending} onClick={() => clone.mutate({ repo: repo.slug, path: repo.root })}>
          {clone.isPending ? 'Cloning…' : 'Clone'}
        </Button>
      </div>
      {clone.data?.ok && <p className="text-xs text-emerald-400">Ready at {clone.data.path}</p>}
      {clone.data && !clone.data.ok && <p className="text-xs text-red-400">{clone.data.error}</p>}
      {clone.error && <p className="text-xs text-red-400">{String(clone.error)}</p>}
      {linked.includes(repo.slug) && <p className="text-[11px] text-fg-faint">Linked to the board.</p>}
    </div>
  );
}

/**
 * The repositories Sloth works in and where it keeps its files. Several repositories share one board:
 * a card's issue says which one its work starts in, and a Trello card that names none is placed by the
 * notes here. The first repository is where the smoke test and the stack install run.
 */
export default function RepositorySection({ draft, patch }: SectionProps) {
  const linked = useProjectFields(draft.project.id || undefined).data?.repositories ?? [];
  const home = useSetupEnv().data?.home ?? '~/.sloth';
  const [typed, setTyped] = useState('');
  const several = draft.repos.length > 1;

  const setRepos = (repos: RepoConfig[]) => {
    // The directories named after the first repository follow a rename while they are still at their default; a custom path stays.
    const was = defaultDirs(repoName(draft.repos[0]?.slug ?? ''), home);
    const now = defaultDirs(repoName(repos[0]?.slug ?? ''), home);
    const follow = (key: DirKey) => (draft[key] === was[key] || draft[key].endsWith(was[key].slice(1)) ? now[key] : draft[key]);
    patch({ repos, worktreesDir: follow('worktreesDir'), sessionsDir: follow('sessionsDir') });
  };
  const add = () => {
    const slug = typed.trim();
    if (!REPO_RE.test(slug) || draft.repos.some((r) => r.slug.toLowerCase() === slug.toLowerCase())) return;
    setRepos([...draft.repos, newRepo(slug, home)]);
    setTyped('');
  };

  return (
    <>
      <p className="pt-4 pb-1 text-xs text-fg-muted">
        The repositories the sessions work in — one board, one or several repositories. A card's issue says which repository its work
        starts in; a session that has to change a second one makes a PR there too. The first repository is where the smoke test and the
        stack install run.{linked.length ? ` Linked to the board: ${linked.join(', ')}.` : ''}
      </p>
      <datalist id="linked-repos">
        {linked.map((r) => (
          <option key={r} value={r} />
        ))}
      </datalist>
      <div className="space-y-3 py-3">
        {draft.repos.map((r, i) => (
          <RepoRow
            key={i}
            repo={r}
            several={several}
            linked={linked}
            onChange={(next) => setRepos(draft.repos.map((x, j) => (j === i ? next : x)))}
            onRemove={draft.repos.length > 1 ? () => setRepos(draft.repos.filter((_, j) => j !== i)) : undefined}
          />
        ))}
        <div className="flex gap-2">
          <TextInput value={typed} onChange={setTyped} placeholder="add a repository — owner/repo" />
          <Button disabled={!REPO_RE.test(typed.trim())} onClick={add}>
            Add
          </Button>
        </div>
      </div>
      <p className="pt-4 pb-1 text-xs text-zinc-400">
        Where Sloth keeps its files. Changing a path does not move what is already there, and running sessions keep the paths they
        started with.
      </p>
      {DIRS.map(({ key, label, hint }) => (
        <Row key={key} label={label} hint={hint} wide>
          <TextInput value={String(draft[key])} onChange={(v) => patch({ [key]: v })} />
        </Row>
      ))}
    </>
  );
}
