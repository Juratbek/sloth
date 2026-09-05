import { defaultDirs } from '../../server/config-types';
import type { SlothConfig } from '../../server/config-types';
import { Button, TextInput, inputStyle } from '../setup/ui';
import { useClone, useProjectFields } from '../setup/use-setup';
import { Row } from './ui';
import { useSetupEnv } from '../setup/use-setup';
import type { SectionProps } from './ui';

type DirKey = keyof ReturnType<typeof defaultDirs>;
const repoName = (repo: string) => repo.split('/')[1] ?? '';

const DIRS: { key: keyof SlothConfig & string; label: string; hint: string }[] = [
  { key: 'runnersDir', label: 'Runners directory', hint: 'Where the wizard clones a repository when no runner root is given.' },
  { key: 'worktreesDir', label: 'Worktrees directory', hint: 'The pool of worktrees the runs work in — slot-1 … slot-N under it, one per active session, kept so their installed dependencies carry over.' },
  { key: 'sessionsDir', label: 'Sessions directory', hint: "Each run's directory — its pid, state, inbox, log, preview." },
  { key: 'stateDir', label: 'State directory', hint: 'Dedupe markers (seen, reviewed, approved, notified), the pause flag, the remote-access secret.' },
  { key: 'watcherLog', label: 'Watcher log', hint: 'One line per event — the log the home panel tails.' },
];

export default function RepositorySection({ draft, patch }: SectionProps) {
  const linked = useProjectFields(draft.project.id || undefined).data?.repositories ?? [];
  const clone = useClone();
  const home = useSetupEnv().data?.home ?? '~/.sloth';
  const setRepo = (repo: string) => {
    // A directory still at its default for the old name follows the new one; a custom path stays.
    const was = defaultDirs(repoName(draft.repo), home);
    const now = defaultDirs(repoName(repo), home);
    const follow = (key: DirKey) => (draft[key] === was[key] || draft[key].endsWith(was[key].slice(1)) ? now[key] : draft[key]);
    patch({ repo, runnerRoot: follow('runnerRoot'), worktreesDir: follow('worktreesDir'), sessionsDir: follow('sessionsDir') });
  };

  return (
    <>
      <Row
        label="Repository"
        hint={`owner/repo — the repository the sessions work in.${linked.length ? ` Linked to the board: ${linked.join(', ')}.` : ''}`}
        wide
      >
        <input
          list="linked-repos"
          value={draft.repo}
          onChange={(e) => setRepo(e.target.value)}
          placeholder="owner/repo"
          spellCheck={false}
          className={inputStyle}
        />
        <datalist id="linked-repos">
          {linked.map((r) => (
            <option key={r} value={r} />
          ))}
        </datalist>
      </Row>
      <Row
        label="Runner root"
        hint={
          <>
            The checkout the sessions run from; Sloth fetches there and makes its worktree slots from it. Clone it if the folder does not exist
            yet.
            {clone.data?.ok && <span className="block text-emerald-400">Ready at {clone.data.path}</span>}
            {clone.data && !clone.data.ok && <span className="block text-red-400">{clone.data.error}</span>}
            {clone.error && <span className="block text-red-400">{String(clone.error)}</span>}
          </>
        }
        wide
      >
        <div className="flex w-full gap-2">
          <TextInput value={draft.runnerRoot} onChange={(runnerRoot) => patch({ runnerRoot })} placeholder="~/.sloth/runners/repo" />
          <Button disabled={!draft.repo || !draft.runnerRoot || clone.isPending} onClick={() => clone.mutate({ repo: draft.repo, path: draft.runnerRoot })}>
            {clone.isPending ? 'Cloning…' : 'Clone'}
          </Button>
        </div>
      </Row>
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
