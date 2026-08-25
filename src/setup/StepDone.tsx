import type { SlothConfig } from '../../server/types';
import { Button, Error } from './ui';
import type { Draft } from './use-setup';
import { useSaveConfig } from './use-setup';

/** The draft plus everything the wizard does not ask about — kept from the saved config when there is one. */
function payload(draft: Draft, existing: SlothConfig | null): Omit<SlothConfig, 'version'> {
  return {
    repo: draft.repo,
    project: draft.project!,
    statusField: {
      id: draft.statusFieldId!,
      columns: {
        pickup: draft.pickup!,
        inProgress: draft.inProgress!,
        needsHelp: draft.needsHelp ?? null,
        codeReview: draft.codeReview!,
      },
    },
    runnerRoot: draft.runnerRoot,
    sessionsDir: existing?.sessionsDir ?? '~/.sloth/sessions',
    stateDir: existing?.stateDir ?? '~/.sloth/state',
    watcherLog: existing?.watcherLog ?? '~/.sloth/watcher.log',
    maxActive: draft.maxActive,
    maxAlive: draft.maxAlive,
    tickSeconds: existing?.tickSeconds ?? 300,
    tickCommand: existing?.tickCommand ?? null,
    model: existing?.model ?? 'opus',
  };
}

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
  const rows: [string, string][] = [
    ['Board', `${config.project.title} · ${config.project.owner}/#${config.project.number}`],
    ['Repository', config.repo],
    ['Runner root', config.runnerRoot],
    ['Watched column', config.statusField.columns.pickup.name],
    ['In Progress', config.statusField.columns.inProgress.name],
    ['Needs help', config.statusField.columns.needsHelp?.name ?? 'not set'],
    ['Code Review', config.statusField.columns.codeReview.name],
    ['Caps', `${config.maxActive} active · ${config.maxAlive} alive`],
  ];

  return (
    <div className="space-y-4">
      <p className="text-sm text-zinc-400">
        This is written to ~/.sloth/config.json. You can change any of it later from the gear in the header.
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
          {save.isPending ? 'Saving…' : 'Save and open the monitor'}
        </Button>
      </div>
    </div>
  );
}
