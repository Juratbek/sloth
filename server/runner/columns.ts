import { cfg } from '../config';
import { graphql, graphqlBody } from './gh';
import { log } from './log';
import { DEFAULT_COLUMN_NAMES } from '../config-types';
import type { ColumnRef, ColumnRole, ConfigColumns, FieldOption } from '../config-types';

const OPTIONS_QUERY = `query($id: ID!) {
  node(id: $id) { ... on ProjectV2SingleSelectField { id name options { id name color description } } } }`;

const UPDATE_FIELD = `mutation($fieldId: ID!, $options: [ProjectV2SingleSelectFieldOptionInput!]!) {
  updateProjectV2Field(input: { fieldId: $fieldId, singleSelectOptions: $options }) {
    projectV2Field { ... on ProjectV2SingleSelectField { id options { id name color description } } } } }`;

/** The roles Sloth creates when the board has no column for them, in the order they are inserted. */
const CREATED: { role: ColumnRole; color: string }[] = [
  { role: 'inProgress', color: 'YELLOW' },
  { role: 'needsHelp', color: 'ORANGE' },
  { role: 'codeReview', color: 'PURPLE' },
  { role: 'approved', color: 'GREEN' },
];

export async function fieldOptions(fieldId: string): Promise<FieldOption[]> {
  const data = await graphql(OPTIONS_QUERY, ['-F', `id=${fieldId}`]);
  return (data.node?.options ?? []) as FieldOption[];
}

let known: ColumnRef[] = [];

/**
 * Every Status column on the board, in board order — the five Sloth roles and all the others
 * (Planning, Backlog, Done…), so a session can carry out "move it to Planning". Refreshed by each tick
 * (1 rate-limit point); a failed read keeps the last list, so a network blip never blanks it.
 */
export async function refreshColumns(): Promise<void> {
  const field = cfg().statusField.id;
  if (!field) return;
  try {
    known = (await fieldOptions(field)).filter((o) => o.id).map(({ id, name }) => ({ id, name }));
  } catch (e) {
    log(`column list read failed: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
  }
}

/** What the last refresh saw; empty before the first one. */
export const knownColumns = (): ColumnRef[] => known;

const byName = (options: FieldOption[], name: string) => options.find((o) => o.name.toLowerCase() === name.toLowerCase());

/** Every option as the mutation wants it — existing ones keep their id, so nothing is dropped. */
const asInput = (o: FieldOption) => ({
  ...(o.id ? { id: o.id } : {}),
  name: o.name,
  color: (o.color ?? 'GRAY').toUpperCase(),
  description: o.description ?? '',
});

/**
 * Resolves the five column roles to real Status option ids, creating the missing In Progress /
 * needs-help / Code Review / Approved options right after the pickup column. The mutation replaces the whole
 * option list, so every existing option is passed back with its id — dropping one deletes it.
 */
export async function ensureColumns(fieldId: string, wanted: Record<ColumnRole, ColumnRef>): Promise<ConfigColumns> {
  let options = await fieldOptions(fieldId);
  const resolve = (role: ColumnRole): FieldOption | undefined =>
    options.find((o) => o.id && o.id === wanted[role].id) ?? byName(options, wanted[role].name || DEFAULT_COLUMN_NAMES[role]);

  const pickup = resolve('pickup');
  if (!pickup) throw new Error(`the watched column "${wanted.pickup.name}" is not on this board`);

  const missing = CREATED.filter(({ role }) => !resolve(role));
  if (missing.length) {
    const created: FieldOption[] = missing.map(({ role, color }) => ({ id: '', name: wanted[role].name || DEFAULT_COLUMN_NAMES[role], color }));
    const at = options.findIndex((o) => o.id === pickup.id) + 1;
    const next = [...options.slice(0, at), ...created, ...options.slice(at)].map(asInput);
    log(`creating board columns: ${created.map((c) => c.name).join(', ')}`);
    const data = await graphqlBody(UPDATE_FIELD, { fieldId, options: next });
    options = (data.updateProjectV2Field?.projectV2Field?.options ?? []) as FieldOption[];
  }

  const out = {} as ConfigColumns;
  for (const role of ['pickup', 'inProgress', 'needsHelp', 'codeReview', 'approved'] as ColumnRole[]) {
    const found = resolve(role);
    if (!found?.id) throw new Error(`could not resolve the ${role} column`);
    out[role] = { id: found.id, name: found.name };
  }
  return out;
}
