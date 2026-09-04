import type { ConfigProject } from '../../server/config-types';
import { boardLabel } from './board-label';
import { Button, Choice, Error, Loading } from './ui';
import { useProjects } from './use-setup';

export default function StepProject({
  selected,
  onSelect,
  onBack,
  onContinue,
}: {
  selected?: ConfigProject;
  onSelect: (project: ConfigProject) => void;
  onBack: () => void;
  onContinue: () => void;
}) {
  const { data, error, isFetching } = useProjects();

  return (
    <div className="space-y-4">
      <p className="text-sm text-zinc-400">Which board should Sloth watch?</p>
      <p className="text-xs text-zinc-500">
        A GitHub Projects (v2) board, or a Trello board — the Trello ones appear once SLOTH_TRELLO_KEY and SLOTH_TRELLO_TOKEN are in
        Sloth's environment. On Trello the lists are the columns, and every card Sloth works gets a GitHub issue opened for it.
      </p>
      {error && <Error>{String(error)}</Error>}
      {!data && isFetching && <Loading what="projects" />}
      {data?.length === 0 && <p className="text-sm text-zinc-400">No open Projects (v2) boards for this account, and no Trello boards.</p>}
      <div className="max-h-[46vh] space-y-2 overflow-y-auto pr-1">
        {data?.map((p) => (
          <Choice
            key={p.id}
            selected={selected?.id === p.id}
            onSelect={() => onSelect({ provider: p.provider, id: p.id, number: p.number, owner: p.owner, title: p.title })}
            title={p.title}
            subtitle={boardLabel(p)}
            right={p.provider === 'trello' ? 'Trello' : `${p.items} items`}
          />
        ))}
      </div>
      <div className="flex gap-2">
        <Button onClick={onBack}>Back</Button>
        <Button variant="primary" onClick={onContinue} disabled={!selected}>
          Continue
        </Button>
      </div>
    </div>
  );
}
