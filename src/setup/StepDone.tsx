import type { SlothConfig } from '../../server/config-types';
import { Button, Error } from './ui';
import type { ConfigPayload, Draft } from './use-setup';
import { useSaveConfig } from './use-setup';

/** The draft plus everything the wizard does not ask about — kept from the saved config when there is one. */
function payload(draft: Draft, existing: SlothConfig | null): ConfigPayload {
  return {
    ...(existing ?? {}),
    repo: draft.repo,
    project: draft.project!,
    statusField: {
      id: draft.statusFieldId!,
      columns: {
        pickup: draft.pickup!,
        inProgress: draft.inProgress!,
        needsHelp: draft.needsHelp!,
        codeReview: draft.codeReview!,
        approved: draft.approved!,
      },
    },
    runnerRoot: draft.runnerRoot,
    orderLogin: draft.orderLogin,
    maxActive: draft.maxActive,
    maxAlive: draft.maxAlive,
  };
}

const columnLabel = (column: { id: string; name: string }) => (column.id ? column.name : `${column.name} (will be created)`);

export default function StepDone({
  draft,
  existing,
  onBack,
  onSaved,
}: {
  draft: Draft;
  existing: SlothConfig | null;
  onBack: () => void;
  onSaved: () => void;
}) {
  const save = useSaveConfig();
  const config = payload(draft, existing);
  const columns = config.statusField.columns;
  const rows: [string, string][] = [
    ['Board', `${config.project.title} · ${config.project.owner}/#${config.project.number}`],
    ['Repository', config.repo],
    ['Runner root', config.runnerRoot],
    ['Watched column', columns.pickup.name],
    ['In Progress', columnLabel(columns.inProgress)],
    ['Needs help', columnLabel(columns.needsHelp)],
    ['Code Review', columnLabel(columns.codeReview)],
    ['Approved', columnLabel(columns.approved)],
    ['Orders from', config.orderLogin || 'nobody'],
    ['Caps', `${config.maxActive} active · ${config.maxAlive} alive`],
  ];

  return (
    <div className="space-y-4">
      <p className="text-sm text-zinc-400">
        This is written to ~/.sloth/config.json, and Sloth starts watching the board straight away. You can change any of
        it later from the gear in the header; the values the wizard does not ask about live in that file.
      </p>
      <dl className="divide-y divide-zinc-900 rounded-md border border-zinc-800">
        {rows.map(([label, value]) => (
          <div key={label} className="flex gap-4 px-3 py-1.5">
            <dt className="w-32 shrink-0 text-xs text-zinc-500">{label}</dt>
            <dd className="min-w-0 flex-1 truncate text-sm text-zinc-200">{value}</dd>
          </div>
        ))}
      </dl>
      {save.error && <Error>{String(save.error)}</Error>}
      <div className="flex gap-2">
        <Button onClick={onBack}>Back</Button>
        <Button variant="primary" disabled={save.isPending} onClick={() => save.mutate(config, { onSuccess: onSaved })}>
          {save.isPending ? 'Saving…' : 'Save and start watching'}
        </Button>
      </div>
    </div>
  );
}
