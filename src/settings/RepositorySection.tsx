import type { SlothConfig } from '../../server/config-types';
import { TextInput } from '../setup/ui';
import { Row } from './ui';
import type { SectionProps } from './ui';

const DIRS: { key: keyof SlothConfig & string; label: string; hint: string }[] = [
  { key: 'runnersDir', label: 'Runners directory', hint: 'Where a repository is cloned when its checkout is left to the default: <runners>/<name>.' },
  { key: 'worktreesDir', label: 'Worktrees directory', hint: 'The pool of worktrees the runs work in — slot-1 … slot-N under it, one per active session and one per repository in each slot, kept so their installed dependencies carry over.' },
  { key: 'sessionsDir', label: 'Sessions directory', hint: "Each run's directory — its pid, state, inbox, log, preview." },
  { key: 'stateDir', label: 'State directory', hint: 'Dedupe markers (seen, reviewed, approved, notified), the pause flag, the remote-access secret.' },
  { key: 'watcherLog', label: 'Watcher log', hint: 'One line per event — the log the home panel tails.' },
];

/**
 * Where Sloth keeps its own files. Which repositories it works in, and where each is checked out, is the
 * *Repositories* page; these are the directories every repository's runs share.
 */
export default function RepositorySection({ draft, patch }: SectionProps) {
  return (
    <>
      <p className="pt-4 pb-1 text-xs text-fg-muted">
        Where Sloth keeps its files. Changing a path does not move what is already there, and running sessions keep the paths they
        started with. A repository's own checkout is on the Repositories page, beside the repository it belongs to.
      </p>
      {DIRS.map(({ key, label, hint }) => (
        <Row key={key} label={label} hint={hint} wide>
          <TextInput value={String(draft[key])} onChange={(v) => patch({ [key]: v })} />
        </Row>
      ))}
    </>
  );
}
