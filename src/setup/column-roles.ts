import { DEFAULT_COLUMN_NAMES, OPT_IN_COLUMNS } from '../../server/config-types';
import type { ColumnRef, ColumnRole, FieldOption } from '../../server/config-types';

/** The first column whose name looks like the role's — how a board Sloth has not seen gets its columns guessed. */
export const MATCH: Record<ColumnRole, RegExp> = {
  pickup: /^\s*to[\s_-]?do\s*$/i,
  inProgress: /in[\s_-]?progress/i,
  needsHelp: /needs?[\s_-]?help|blocked|question/i,
  codeReview: /review/i,
  approved: /approved|accepted/i,
  qa: /^\s*(qa|testing|in[\s_-]?test(ing)?)\s*$/i,
  done: /^\s*(done|closed|complete[d]?|shipped|merged)\s*$/i,
};

/** The columns Sloth moves cards to, in the order they are asked about. An opt-in one is "none" until chosen, never created unasked. */
export const OTHERS: { role: ColumnRole; label: string; hint: string; none?: string }[] = [
  { role: 'inProgress', label: 'In Progress', hint: 'where a card goes while a session works on it' },
  { role: 'needsHelp', label: 'Needs help', hint: 'where a blocked session parks its card' },
  { role: 'codeReview', label: 'Code Review', hint: 'where a card goes once its PR is open — Sloth reviews it there' },
  { role: 'approved', label: 'Approved', hint: 'where a card goes once its PR passed the review — ready for you to test' },
  { role: 'qa', label: 'QA', hint: 'the merged fixes a daily sweep tests on the QA branch — a pass goes to Done, a fail back to In Progress', none: 'none — no QA sweep' },
  { role: 'done', label: 'Done', hint: 'where a card goes once its issue is closed — a merged PR closes it' },
];

const NONE: ColumnRef = { id: '', name: '' };
/** What an empty choice means for the role: a column to create under the default name, or — opt-in — no column at all. */
const blank = (role: ColumnRole): ColumnRef => (OPT_IN_COLUMNS.includes(role) ? NONE : { id: '', name: DEFAULT_COLUMN_NAMES[role] });

/**
 * The column for a role on a board with these options: the chosen one when it is still there (or is
 * one to create), else the first name match, else one to create under the default name — or, for an
 * opt-in role, none.
 */
export function columnFor(role: ColumnRole, chosen: ColumnRef | undefined, options: FieldOption[]): ColumnRef {
  if (chosen?.id ? options.some((o) => o.id === chosen.id) : chosen?.name) return chosen!;
  return options.find((o) => MATCH[role].test(o.name)) ?? blank(role);
}

/** What a column select's value means: an option's id, or `''` for "create it under the default name" (opt-in: "none"). */
export const pickColumn = (role: ColumnRole, id: string, options: FieldOption[]): ColumnRef => options.find((o) => o.id === id) ?? blank(role);
