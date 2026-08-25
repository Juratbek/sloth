import type { ConfigProject } from '../../server/config-types';
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
      <p className="text-sm text-zinc-400">Which GitHub project board should Sloth watch?</p>
      {error && <Error>{String(error)}</Error>}
      {!data && isFetching && <Loading what="projects" />}
      {data?.length === 0 && <p className="text-sm text-zinc-500">No open Projects (v2) found for this account.</p>}
      <div className="max-h-[46vh] space-y-2 overflow-y-auto pr-1">
        {data?.map((p) => (
          <Choice
            key={p.id}
            selected={selected?.id === p.id}
            onSelect={() => onSelect({ id: p.id, number: p.number, owner: p.owner, title: p.title })}
            title={p.title}
            subtitle={`${p.owner} · #${p.number}`}
            right={`${p.items} items`}
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
