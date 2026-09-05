import type { ReactNode } from 'react';
import type { RepoConfig } from '../../server/config-types';
import { Field, TextInput } from './ui';

/**
 * The two things a picked repository is asked for — where its checkout goes and what it is — shown
 * under its row in the picker. The wizard's step and Settings → *Repositories* fill in the same fields,
 * so a repository is described the same way whichever page the user is on; only the settings page puts
 * a Clone button beside the path, since the wizard clones what it was given when the setup is saved.
 */

const repoName = (slug: string) => slug.split('/')[1] || 'repo';

export function CheckoutField({ repo, onChange, action }: { repo: RepoConfig; onChange: (root: string) => void; action?: ReactNode }) {
  return (
    <Field
      label="Checkout"
      hint="Sloth clones the repository here itself once the setup is saved, if the folder is not there yet. The worktree slots the sessions work in are made next to it, under ~/.sloth/worktrees."
    >
      <div className="flex w-full gap-2">
        <TextInput value={repo.root} onChange={onChange} placeholder={`~/.sloth/runners/${repoName(repo.slug)}`} />
        {action}
      </div>
    </Field>
  );
}

export function NoteField({ repo, onChange }: { repo: RepoConfig; onChange: (note: string) => void }) {
  return (
    <Field label="What it is" hint="One line: what this repository holds. A card that names no repository is placed by these notes.">
      <TextInput value={repo.note} onChange={onChange} placeholder="the web app · the mobile API · the shared component library" />
    </Field>
  );
}
