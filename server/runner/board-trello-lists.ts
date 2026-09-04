import { DEFAULT_COLUMN_NAMES, OPTIONAL_COLUMNS, OPT_IN_COLUMNS } from '../config-types';
import type { ColumnRef, ColumnRole, ConfigColumns } from '../config-types';
import * as trello from '../trello';
import type { TrelloList } from '../trello';
import { log } from './log';

/** The wizard's half of a Trello board: the lists Sloth's roles resolve to, created when the board lacks them. */

const ROLES: ColumnRole[] = ['pickup', 'inProgress', 'needsHelp', 'codeReview', 'approved', 'qa', 'done'];

const asked = (role: ColumnRole, wanted: Record<ColumnRole, ColumnRef>) => !OPT_IN_COLUMNS.includes(role) || !!(wanted[role].id || wanted[role].name);
const byName = (lists: TrelloList[], name: string) => lists.find((l) => l.name.toLowerCase() === name.toLowerCase());

/**
 * Resolves the column roles to real lists, creating the missing ones — the flow lists right after the
 * pickup list, Done at the far right — the way `ensureColumns` does for a Status field.
 */
export async function ensureTrelloLists(board: string, wanted: Record<ColumnRole, ColumnRef>): Promise<ConfigColumns> {
  let lists = await trello.lists(board);
  const resolve = (role: ColumnRole): TrelloList | undefined =>
    asked(role, wanted) ? (lists.find((l) => l.id === wanted[role].id) ?? byName(lists, wanted[role].name || DEFAULT_COLUMN_NAMES[role])) : undefined;
  const pickup = resolve('pickup');
  if (!pickup) throw new Error(`the watched list "${wanted.pickup.name}" is not on this board`);
  const nameOf = (role: ColumnRole) => wanted[role].name || DEFAULT_COLUMN_NAMES[role];
  const middle = (['inProgress', 'needsHelp', 'codeReview', 'approved', 'qa'] as ColumnRole[]).filter((role) => asked(role, wanted) && !resolve(role));
  const last = (['done'] as ColumnRole[]).filter((role) => asked(role, wanted) && !resolve(role));
  if (middle.length || last.length) {
    log(`creating Trello lists: ${[...middle, ...last].map(nameOf).join(', ')}`);
    const after = lists.find((l) => l.pos > pickup.pos);
    const gap = after ? (after.pos - pickup.pos) / (middle.length + 1) : 1024;
    for (const [i, role] of middle.entries()) await trello.createList(board, nameOf(role), pickup.pos + gap * (i + 1));
    for (const role of last) await trello.createList(board, nameOf(role), 'bottom');
    lists = await trello.lists(board);
  }
  const out = {} as ConfigColumns;
  for (const role of ROLES) {
    const found = resolve(role);
    if (!found && OPTIONAL_COLUMNS.includes(role) && !asked(role, wanted)) {
      out[role] = { id: '', name: '' };
      continue;
    }
    if (!found) throw new Error(`could not resolve the ${role} list`);
    out[role] = { id: found.id, name: found.name };
  }
  return out;
}
