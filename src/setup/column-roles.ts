import { DEFAULT_COLUMN_NAMES } from '../../server/config-types';
import type { ColumnRef, ColumnRole, FieldOption } from '../../server/config-types';

/** The first column whose name looks like the role's — how a board Sloth has not seen gets its columns guessed. */
export const MATCH: Record<ColumnRole, RegExp> = {
  pickup: /^\s*to[\s_-]?do\s*$/i,
  inProgress: /in[\s_-]?progress/i,
  needsHelp: /needs?[\s_-]?help|blocked|question/i,
  codeReview: /review/i,
  approved: /approved|accepted/i,
};

/** The columns Sloth moves cards to, in the order they are asked about. */
export const OTHERS: { role: ColumnRole; label: string; hint: string }[] = [
  { role: 'inProgress', label: 'In Progress', hint: 'where a card goes while a session works on it' },
  { role: 'needsHelp', label: 'Needs help', hint: 'where a blocked session parks its card' },
  { role: 'codeReview', label: 'Code Review', hint: 'where a card goes once its PR is open' },
  { role: 'approved', label: 'Approved', hint: 'cards you approve get a final review of their PR' },
];

/**
 * The column for a role on a board with these options: the chosen one when it is still there (or is
 * one to create), else the first name match, else one to create under the default name.
 */
export function columnFor(role: ColumnRole, chosen: ColumnRef | undefined, options: FieldOption[]): ColumnRef {
  if (chosen?.id ? options.some((o) => o.id === chosen.id) : chosen?.name) return chosen!;
  return options.find((o) => MATCH[role].test(o.name)) ?? { id: '', name: DEFAULT_COLUMN_NAMES[role] };
}

/** What a column select's value means: an option's id, or `''` for "create it under the default name". */
export const pickColumn = (role: ColumnRole, id: string, options: FieldOption[]): ColumnRef =>
  options.find((o) => o.id === id) ?? { id: '', name: DEFAULT_COLUMN_NAMES[role] };
