import type { RepoConfig, SlothConfig } from '../../server/config-types';
import RepoPicker from '../setup/RepoPicker';
import { Button, TextInput } from '../setup/ui';
import { REPO_RE, useClone, useProjectFields, useSetupEnv } from '../setup/use-setup';
import { Row } from './ui';
import type { SectionProps } from './ui';

const repoName = (repo: string) => repo.split('/')[1] ?? '';

const DIRS: { key: keyof SlothConfig & string; label: string; hint: string }[] = [
  { key: 'runnersDir', label: 'Runners directory', hint: 'Where a repository is cloned when its checkout is left to the default: <runners>/<name>.' },
  { key: 'worktreesDir', label: 'Worktrees directory', hint: 'The pool of worktrees the runs work in — slot-1 … slot-N under it, one per active session and one per repository in each slot, kept so their installed dependencies carry over.' },
  { key: 'sessionsDir', label: 'Sessions directory', hint: "Each run's directory — its pid, state, inbox, log, preview." },
  { key: 'stateDir', label: 'State directory', hint: 'Dedupe markers (seen, reviewed, approved, notified), the pause flag, the remote-access secret.' },
  { key: 'watcherLog', label: 'Watcher log', hint: 'One line per event — the log the home panel tails.' },
];

/** One picked repository's row: what it is, where its checkout is, and a button to clone it now. */
function RepoRow({ repo, several, linked, legacy, onChange }: { repo: RepoConfig; several: boolean; linked: string[]; legacy?: boolean; onChange: (r: RepoConfig) => void }) {
  const clone = useClone();
  const ok = REPO_RE.test(repo.slug);
  return (
    <div className="space-y-2 rounded-md border border-edge p-3">
      <p className="text-sm text-fg-strong">{repo.slug}</p>
      {several && (
        <TextInput value={repo.note} onChange={(note) => onChange({ ...repo, note })} placeholder="What it is, in one line — a card that names no repository is placed by this" />
      )}
      <div className="flex w-full gap-2">
        <TextInput value={repo.root} onChange={(root) => onChange({ ...repo, root })} placeholder={`~/.sloth/runners/${repoName(repo.slug) || 'repo'}`} />
        <Button disabled={!ok || !repo.root || clone.isPending} onClick={() => clone.mutate({ repo: repo.slug, path: repo.root })}>
          {clone.isPending ? 'Cloning…' : 'Clone'}
        </Button>
      </div>
      {clone.data?.ok && <p className="text-xs text-ok-fg">Ready at {clone.data.path}</p>}
      {clone.data && !clone.data.ok && <p className="text-xs text-danger">{clone.data.error}</p>}
      {clone.error && <p className="text-xs text-danger">{String(clone.error)}</p>}
      {linked.includes(repo.slug) && <p className="text-[11px] text-fg-faint">Linked to the board.</p>}
      {legacy && <p className="text-[11px] text-fg-faint">The first repository this Sloth watched — its files on disk carry no repository name, so it cannot be removed.</p>}
    </div>
  );
}

/**
 * The repositories Sloth works in and where it keeps its files. They are ticked off everything the
 * logged-in GitHub account can reach — the same picker the wizard shows. Several repositories share one
 * board: a card's issue says which one its work starts in, and a Trello card that names none is placed by
 * the notes here. The first repository is where the smoke test and the stack install run.
 */
export default function RepositorySection({ draft, patch }: SectionProps) {
  const linked = useProjectFields(draft.project.id || undefined).data?.repositories ?? [];
  const home = useSetupEnv().data?.home ?? '~/.sloth';
  const several = draft.repos.length > 1;
  // The repository the untagged files belong to (`legacyRepo`): its runs, markers and worktrees carry no
  // repository name, so it stays ticked. Falling back to the first also keeps one repository on the list.
  const legacy = draft.repos.find((r) => r.slug.toLowerCase() === draft.legacyRepo.toLowerCase())?.slug ?? draft.repos[0]?.slug ?? '';
  const isLegacy = (slug: string) => slug.toLowerCase() === legacy.toLowerCase();

  return (
    <>
      <p className="pt-4 pb-1 text-xs text-fg-muted">
        The repositories the sessions work in — one board, one or several repositories. A card's issue says which repository its work
        starts in; a session that has to change a second one makes a PR there too. The first repository is where the smoke test and the
        stack install run.{linked.length ? ` Linked to the board: ${linked.join(', ')}.` : ''}
      </p>
      <div className="space-y-3 py-3">
        <RepoPicker repos={draft.repos} onChange={(repos) => patch({ repos })} linked={linked} home={home} locked={legacy} />
        {draft.repos.map((r, i) => (
          <RepoRow
            key={i}
            repo={r}
            several={several}
            linked={linked}
            onChange={(next) => patch({ repos: draft.repos.map((x, j) => (j === i ? next : x)) })}
            legacy={several && isLegacy(r.slug)}
          />
        ))}
      </div>
      <p className="pt-4 pb-1 text-xs text-fg-muted">
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
