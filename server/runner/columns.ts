import { cfg } from '../config';
import { trelloColumns } from './board-trello';
import { graphql, graphqlBody } from './gh';
import { log } from './log';
import { DEFAULT_COLUMN_NAMES, OPTIONAL_COLUMNS, OPT_IN_COLUMNS } from '../config-types';
import type { ColumnRef, ColumnRole, ConfigColumns, FieldOption } from '../config-types';

const OPTIONS_QUERY = `query($id: ID!) {
  node(id: $id) { ... on ProjectV2SingleSelectField { id name options { id name color description } } } }`;

const UPDATE_FIELD = `mutation($fieldId: ID!, $options: [ProjectV2SingleSelectFieldOptionInput!]!) {
  updateProjectV2Field(input: { fieldId: $fieldId, singleSelectOptions: $options }) {
    projectV2Field { ... on ProjectV2SingleSelectField { id options { id name color description } } } } }`;

/** The roles Sloth creates when the board has no column for them, in the order they are inserted after the pickup column. */
const CREATED: { role: ColumnRole; color: string }[] = [
  { role: 'inProgress', color: 'YELLOW' },
  { role: 'needsHelp', color: 'ORANGE' },
  { role: 'codeReview', color: 'PURPLE' },
  { role: 'approved', color: 'GREEN' },
  { role: 'qa', color: 'BLUE' },
];
/** Done belongs at the end of the board, not next to the flow columns. */
const CREATED_LAST: { role: ColumnRole; color: string }[] = [{ role: 'done', color: 'GRAY' }];
const ROLES: ColumnRole[] = ['pickup', 'inProgress', 'needsHelp', 'codeReview', 'approved', 'qa', 'done'];
/** Whether a role is wanted at all: an opt-in one (QA) only with an id or a name — a board without a QA step gets no column. */
const asked = (role: ColumnRole, wanted: Record<ColumnRole, ColumnRef>) => !OPT_IN_COLUMNS.includes(role) || !!(wanted[role].id || wanted[role].name);

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
    known = cfg().project.provider === 'trello' ? await trelloColumns() : (await fieldOptions(field)).filter((o) => o.id).map(({ id, name }) => ({ id, name }));
  } catch (e) {
    log(`column list read failed: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
  }
}

/** What the last refresh saw; empty before the first one. */
export const knownColumns = (): ColumnRef[] => known;

/** Tests start a case from a board nobody has read yet, as a fresh Sloth does. */
export const resetColumns = (): void => {
  known = [];
};

/**
 * The columns a card can be parked in, so trigger 6 knows where to look for a `blocked` marker: `park`
 * leaves one wherever the card stood when the move to needs-help was refused, or when the board has no
 * such column — In Progress, but also Code Review (a review given up or stopped) and Approved (a PR
 * closed unmerged). The pickup column is deliberately not one of them: the park comment offers moving the
 * card back there as the way to *start over*, and trigger 6 relaunching it first would continue the dead
 * run instead — its handoff kept, its hours booked as continued.
 */
export const parkedColumns = (): string[] => {
  const col = cfg().statusField.columns;
  return [col.inProgress, col.needsHelp, col.codeReview, col.approved].map((c) => c.name).filter(Boolean);
};

/**
 * The columns Sloth still has something to do in — a card outside them is nobody's business. The pickup
 * column is one: a card left there whose issue was closed is filed away rather than picked up.
 */
export const workedColumns = (): string[] => [cfg().statusField.columns.pickup.name, ...parkedColumns()].filter(Boolean);

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
    asked(role, wanted) ? (options.find((o) => o.id && o.id === wanted[role].id) ?? byName(options, wanted[role].name || DEFAULT_COLUMN_NAMES[role])) : undefined;

  const pickup = resolve('pickup');
  if (!pickup) throw new Error(`the watched column "${wanted.pickup.name}" is not on this board`);

  const create = (list: typeof CREATED): FieldOption[] =>
    list
      .filter(({ role }) => asked(role, wanted) && !resolve(role))
      .map(({ role, color }) => ({ id: '', name: wanted[role].name || DEFAULT_COLUMN_NAMES[role], color }));
  const middle = create(CREATED);
  const last = create(CREATED_LAST);
  if (middle.length || last.length) {
    const created = [...middle, ...last];
    const at = options.findIndex((o) => o.id === pickup.id) + 1;
    const next = [...options.slice(0, at), ...middle, ...options.slice(at), ...last].map(asInput);
    log(`creating board columns: ${created.map((c) => c.name).join(', ')}`);
    const data = await graphqlBody(UPDATE_FIELD, { fieldId, options: next });
    options = (data.updateProjectV2Field?.projectV2Field?.options ?? []) as FieldOption[];
  }

  const out = {} as ConfigColumns;
  for (const role of ROLES) {
    const found = resolve(role);
    if (!found?.id && OPTIONAL_COLUMNS.includes(role) && !asked(role, wanted)) {
      out[role] = { id: '', name: '' };
      continue;
    }
    if (!found?.id) throw new Error(`could not resolve the ${role} column`);
    out[role] = { id: found.id, name: found.name };
  }
  return out;
}
