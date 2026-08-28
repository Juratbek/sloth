import { useEffect } from 'react';
import { DEFAULT_COLUMN_NAMES } from '../../server/config-types';
import type { ColumnRole, ConfigColumns } from '../../server/config-types';
import { OTHERS, columnFor, pickColumn } from '../setup/column-roles';
import { Error, Loading, Select } from '../setup/ui';
import { useProjectFields, useProjects } from '../setup/use-setup';
import { Choose, Row } from './ui';
import type { SectionProps } from './ui';

const ROLES: ColumnRole[] = ['pickup', 'inProgress', 'needsHelp', 'codeReview', 'approved', 'done'];
const BLANK = { id: '', name: '' };

export default function BoardSection({ draft, patch }: SectionProps) {
  const projects = useProjects();
  const fields = useProjectFields(draft.project.id || undefined);
  const status = fields.data?.statusField;
  const options = status?.options ?? [];
  const columns = draft.statusField.columns;

  // A board Sloth has not seen: take its Status field and guess the columns from their names.
  useEffect(() => {
    if (!status || status.id === draft.statusField.id) return;
    const guessed = Object.fromEntries(ROLES.map((role) => [role, columnFor(role, undefined, status.options)])) as unknown as ConfigColumns;
    patch({ statusField: { id: status.id, columns: guessed } });
  }, [status?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const list = projects.data ?? [];
  // The saved board stays choosable even while the list is loading or no longer includes it.
  const known = list.some((p) => p.id === draft.project.id) || !draft.project.id ? list : [{ ...draft.project, url: '', items: 0 }, ...list];
  const choose = (id: string) => {
    const p = list.find((x) => x.id === id);
    if (!p || p.id === draft.project.id) return;
    patch({
      project: { id: p.id, number: p.number, owner: p.owner, title: p.title },
      statusField: { id: '', columns: { pickup: BLANK, inProgress: BLANK, needsHelp: BLANK, codeReview: BLANK, approved: BLANK, done: BLANK } },
    });
  };
  const set = (role: ColumnRole, id: string) =>
    patch({ statusField: { ...draft.statusField, columns: { ...columns, [role]: pickColumn(role, id, options) } } });

  return (
    <>
      <Row label="Project board" hint="The GitHub Projects (v2) board Sloth watches. Picking another board re-guesses the columns below." wide>
        <div className="w-full space-y-1">
          <Choose
            label="Project board"
            value={draft.project.id}
            onChange={choose}
            options={known.map((p) => ({ id: p.id, name: `${p.title} · ${p.owner}/#${p.number}` }))}
            placeholder={projects.isFetching ? 'loading boards…' : 'choose a board'}
          />
          {projects.error && <Error>{String(projects.error)}</Error>}
        </div>
      </Row>
      {!fields.data && fields.isFetching && <Loading what="columns" />}
      {fields.error && <Error>{String(fields.error)}</Error>}
      {fields.data && !status && <Error>This project has no Status field — add one on the board first.</Error>}
      <Row label="Watched column" hint="Sloth picks unassigned cards up from here. It only ever reads this column.">
        <Choose label="Watched column" value={columns.pickup.id} onChange={(id) => set('pickup', id)} options={options} placeholder="choose a column" />
      </Row>
      {OTHERS.map(({ role, label, hint }) => (
        <Row
          key={role}
          label={label}
          hint={columns[role].id ? hint : `${hint} — “${columns[role].name || DEFAULT_COLUMN_NAMES[role]}” will be created on the board when you save`}
        >
          <Select value={columns[role].id} onChange={(id) => set(role, id)} options={options} placeholder={`create “${DEFAULT_COLUMN_NAMES[role]}”`} />
        </Row>
      ))}
    </>
  );
}
