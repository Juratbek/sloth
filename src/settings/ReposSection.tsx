import { useEffect, useRef, useState } from 'react';
import type { RepoConfig } from '../../server/config-types';
import RepoPicker from '../setup/RepoPicker';
import { CheckoutField, NoteField } from '../setup/RepoFields';
import { Button } from '../setup/ui';
import { REPO_RE, useClone, useProjectFields, useSetupEnv } from '../setup/use-setup';
import type { SectionProps } from './ui';

/** A picked repository's options, open under its row: where its checkout goes, what it is, and a clone now. */
function RepoOptions({ repo, first, several, onChange }: { repo: RepoConfig; first: boolean; several: boolean; onChange: (r: RepoConfig) => void }) {
  const clone = useClone();
  const ok = REPO_RE.test(repo.slug) && !!repo.root.trim();
  return (
    <div className="space-y-3">
      {first && several && <p className="text-[11px] text-fg-faint">first — the smoke test and the stack install run here</p>}
      <CheckoutField
        repo={repo}
        onChange={(root) => onChange({ ...repo, root })}
        action={
          <Button disabled={!ok || clone.isPending} onClick={() => clone.mutate({ repo: repo.slug, path: repo.root })}>
            {clone.isPending ? 'Cloning…' : 'Clone'}
          </Button>
        }
      />
      {clone.data?.ok && <p className="text-xs text-ok-fg">Ready at {clone.data.path}</p>}
      {clone.data && !clone.data.ok && <p className="text-xs text-danger">{clone.data.error}</p>}
      {clone.error && <p className="text-xs text-danger">{String(clone.error)}</p>}
      <NoteField repo={repo} onChange={(note) => onChange({ ...repo, note })} />
    </div>
  );
}

/** "Saved" is worth saying, but only for a moment: a save that landed a minute ago is not news. */
function useJustSaved(saving: boolean, saveError?: string) {
  const [saved, setSaved] = useState(false);
  const before = useRef(saving);
  useEffect(() => {
    const landed = before.current && !saving && !saveError;
    before.current = saving;
    if (!landed) return;
    setSaved(true);
    const clear = setTimeout(() => setSaved(false), 4000);
    return () => clearTimeout(clear);
  }, [saving, saveError]);
  return saved;
}

function Footer({ dirty, saving, saveError, save, discard }: { dirty: boolean; saving: boolean; saveError?: string; save: () => void; discard: () => void }) {
  const saved = useJustSaved(saving, saveError);
  return (
    <div className="sticky bottom-0 -mx-6 mt-6 border-t border-edge bg-surface/95 backdrop-blur">
      <div className="flex items-center gap-2 px-6 py-3 text-xs">
        {saveError ? (
          <span className="min-w-0 truncate text-danger">{saveError}</span>
        ) : dirty ? (
          <span className="text-fg-muted">Unsaved changes.</span>
        ) : saved ? (
          <span className="text-ok-fg">Saved.</span>
        ) : (
          <span className="text-fg-faint">Everything here is saved.</span>
        )}
        <span className="flex-1" />
        <Button disabled={!dirty || saving} onClick={discard}>
          Discard
        </Button>
        <Button variant="primary" disabled={!dirty || saving} onClick={save}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  );
}

/**
 * The repositories Sloth works in, ticked off everything the logged-in GitHub account can reach — the same
 * picker the wizard shows, with the whole list open from the moment the page does. Several repositories
 * share one board: a card's issue says which one its work starts in, and a card that names none is placed
 * by the notes here. The first repository is where the smoke test and the stack install run. The page
 * saves itself: a repository is not something to tick and then hunt for a bar at the bottom of the window.
 */
export default function ReposSection({ draft, patch, baseline, save, discard, saving, saveError }: SectionProps) {
  const linked = useProjectFields(draft.project.id || undefined).data?.repositories ?? [];
  const home = useSetupEnv().data?.home ?? '~/.sloth';
  const several = draft.repos.length > 1;
  // The repository the untagged files belong to (`legacyRepo`): its runs, markers and worktrees carry no
  // repository name, so it stays ticked. Falling back to the first also keeps one repository on the list.
  const legacy = draft.repos.find((r) => r.slug.toLowerCase() === draft.legacyRepo.toLowerCase())?.slug ?? draft.repos[0]?.slug ?? '';

  return (
    <div>
      <p className="pt-4 pb-3 text-xs text-fg-muted">
        The repositories the sessions work in — one board, one or several repositories. Tick the ones Sloth may work in; a ticked one
        opens on where its checkout goes and what it is. A card's issue says which repository its work starts in, and the first
        repository is where the smoke test and the stack install run.{linked.length ? ` Linked to the board: ${linked.join(', ')}.` : ''}
      </p>
      <RepoPicker
        repos={draft.repos}
        onChange={(repos) => patch({ repos })}
        linked={linked}
        home={home}
        locked={legacy}
        details={(repo, at) => (
          <RepoOptions
            repo={repo}
            first={at === 0}
            several={several}
            onChange={(next) => patch({ repos: draft.repos.map((x, j) => (j === at ? next : x)) })}
          />
        )}
      />
      <Footer dirty={JSON.stringify(draft) !== JSON.stringify(baseline)} saving={saving} saveError={saveError} save={save} discard={discard} />
    </div>
  );
}
