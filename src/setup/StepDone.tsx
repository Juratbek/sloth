import type { SlothConfig } from '../../server/config-types';
import { stackLabel } from '../components/StackPanel';
import { boardLabel } from './board-label';
import { Button, Error } from './ui';
import type { ConfigPayload, Draft } from './use-setup';
import { useSaveConfig } from './use-setup';

/** The draft plus everything the wizard does not ask about — kept from the saved config when there is one. */
function payload(draft: Draft, existing: SlothConfig | null): ConfigPayload {
  return {
    ...(existing ?? {}),
    repos: draft.repos,
    project: draft.project!,
    statusField: {
      id: draft.statusFieldId!,
      columns: {
        pickup: draft.pickup!,
        inProgress: draft.inProgress!,
        needsHelp: draft.needsHelp!,
        codeReview: draft.codeReview!,
        approved: draft.approved!,
        qa: draft.qa ?? { id: '', name: '' },
        done: draft.done!,
      },
    },
    roles: { admin: draft.admin, developers: draft.developers, testers: draft.testers },
    maxActive: draft.maxActive,
    maxAlive: draft.maxAlive,
    previewHours: draft.previewHours,
    stack: draft.stack,
    helpLogins: draft.helpLogins,
    helpWebhook: draft.helpWebhook,
  };
}

const people = (logins: string[]) => logins.map((l) => `@${l}`).join(' · ') || 'nobody';
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
    ['Board', `${config.project.title} · ${boardLabel(config.project)}`],
    [config.repos.length > 1 ? 'Repositories' : 'Repository', config.repos.map((r) => r.slug).join(' · ')],
    [config.repos.length > 1 ? 'Checkouts' : 'Checkout', config.repos.map((r) => r.root).join(' · ')],
    ['Watched column', columns.pickup.name],
    ['In Progress', columnLabel(columns.inProgress)],
    ['Needs help', columnLabel(columns.needsHelp)],
    ['Code Review', columnLabel(columns.codeReview)],
    ['Approved', columnLabel(columns.approved)],
    ['QA', columns.qa.id || columns.qa.name ? columnLabel(columns.qa) : 'none — no QA sweep'],
    ['Done', columnLabel(columns.done)],
    ['Admin', config.roles.admin || 'nobody'],
    ['Developers', people(config.roles.developers)],
    ['Testers', people(config.roles.testers)],
    ['Needs help → notify', [...(config.helpLogins ?? []).map((l) => `@${l}`), config.helpWebhook && 'webhook'].filter(Boolean).join(' · ') || 'nobody'],
    ['Caps', `${config.maxActive} active · ${config.maxAlive} alive`],
    ['Previews', config.previewHours ? `${config.previewHours} h behind a link on the PR` : 'off'],
    ['Stack', stackLabel(config.stack ?? 'auto')],
  ];

  return (
    <div className="space-y-4">
      <p className="text-sm text-zinc-400">
        This is written to ~/.sloth/config.json, and Sloth starts watching the board straight away. Every value — including
        the ones the wizard does not ask about, like which model each agent runs on — can be changed later in Settings, the
        gear in the header.
      </p>
      <dl className="divide-y divide-zinc-900 rounded-md border border-zinc-800">
        {rows.map(([label, value]) => (
          <div key={label} className="flex gap-4 px-3 py-1.5">
            <dt className="w-32 shrink-0 text-xs text-zinc-400">{label}</dt>
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
