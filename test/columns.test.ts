import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureColumns, fieldOptions, knownColumns, refreshColumns } from '../server/runner/columns';
import type { ColumnRef, ColumnRole, FieldOption } from '../server/config-types';
import { fail, onGh, resetGh } from './gh-mock';
import { configure, readLog, wipe } from './harness';

vi.mock('../server/runner/gh', () => import('./gh-mock'));

/**
 * The board's Status field: reading its options, and resolving the seven column roles against them —
 * creating the ones the board has not got. The mutation replaces the whole option list, so what is sent
 * back matters as much as what comes out: an option dropped from it is deleted off the board.
 */

const ROLES: ColumnRole[] = ['pickup', 'inProgress', 'needsHelp', 'codeReview', 'approved', 'qa', 'done'];

/** Every role asked for by name, none by id, unless the test says otherwise. */
const asking = (over: Partial<Record<ColumnRole, ColumnRef>> = {}): Record<ColumnRole, ColumnRef> =>
  Object.fromEntries(ROLES.map((role) => [role, over[role] ?? { id: '', name: '' }])) as Record<ColumnRole, ColumnRef>;

let options: FieldOption[] = [];
/** What the mutation was asked to make the option list, in order — the whole list, every time. */
let sent: { id?: string; name: string; color: string }[] = [];
/** The GitHub errors and empty answers a test can arrange, read by the handlers below. */
let readFails = '';
let notAField = false;
let updateReturnsNothing = false;

/** A board whose Status field has these columns, in this order. */
function board(...names: string[]): void {
  options = names.map((name, i) => ({ id: `o${i + 1}`, name, color: 'GRAY', description: '' }));
}

beforeEach(() => {
  configure();
  wipe();
  resetGh();
  options = [];
  sent = [];
  readFails = '';
  notAField = false;
  updateReturnsNothing = false;
  onGh(/node\(id: \$id\)/, () => (readFails ? fail(readFails) : { data: { node: notAField ? {} : { id: 'PVTSSF_1', name: 'Status', options } } }));
  onGh(/ProjectV2SingleSelectFieldOptionInput/, (call) => {
    sent = JSON.parse(call.args[call.args.length - 1]).options;
    // GitHub hands every option back, the new ones with the ids it just minted.
    options = updateReturnsNothing ? [] : sent.map((o, i) => ({ id: o.id || `new${i + 1}`, name: o.name, color: o.color, description: '' }));
    return { data: { updateProjectV2Field: { projectV2Field: { id: 'PVTSSF_1', options } } } };
  });
});

describe('fieldOptions', () => {
  it('reads the Status field’s options, and nothing at all off a field that is not one', async () => {
    board('Todo', 'Done');
    expect(await fieldOptions('PVTSSF_1')).toMatchObject([{ id: 'o1', name: 'Todo' }, { id: 'o2', name: 'Done' }]);
    notAField = true;
    expect(await fieldOptions('PVTSSF_1')).toEqual([]);
  });
});

describe('refreshColumns', () => {
  it('remembers every column on the board in board order, so a session can move a card anywhere', async () => {
    board('Backlog', 'Todo', 'In Progress', 'Planning', 'Done');
    await refreshColumns();
    expect(knownColumns()).toEqual([
      { id: 'o1', name: 'Backlog' },
      { id: 'o2', name: 'Todo' },
      { id: 'o3', name: 'In Progress' },
      { id: 'o4', name: 'Planning' },
      { id: 'o5', name: 'Done' },
    ]);
  });

  it('keeps the last list when the read fails, so a network blip never blanks it', async () => {
    board('Todo', 'Done');
    await refreshColumns();
    const before = knownColumns();
    readFails = 'HTTP 502 — could not reach GitHub';
    await refreshColumns();
    expect(knownColumns()).toEqual(before);
    expect(readLog().join('\n')).toMatch(/column list read failed: HTTP 502/);
  });
});

describe('ensureColumns', () => {
  it('resolves the roles that are already on the board, by id and by name whatever its case', async () => {
    board('todo', 'In Progress', 'Sloth needs help', 'Code Review', 'Approved', 'Done');
    const out = await ensureColumns('PVTSSF_1', asking({ inProgress: { id: 'o2', name: 'a stale name' } }));
    expect(out.pickup).toEqual({ id: 'o1', name: 'todo' });
    expect(out.inProgress).toEqual({ id: 'o2', name: 'In Progress' }); // found by id, named as the board names it
    expect(out.codeReview).toEqual({ id: 'o4', name: 'Code Review' });
    expect(out.done).toEqual({ id: 'o6', name: 'Done' });
    expect(sent).toEqual([]); // nothing was missing, so the option list was never rewritten
  });

  it('creates the flow columns right after the pickup one and Done at the end, keeping every existing option', async () => {
    board('Backlog', 'Todo', 'Icebox');
    const out = await ensureColumns('PVTSSF_1', asking());
    expect(sent.map((o) => o.name)).toEqual(['Backlog', 'Todo', 'In Progress', 'Sloth needs help', 'Code Review', 'Approved', 'Icebox', 'Done']);
    // Every option the board already had is passed back with its id — one dropped from the list is deleted.
    expect(sent.filter((o) => o.id).map((o) => o.id)).toEqual(['o1', 'o2', 'o3']);
    expect(out.inProgress.name).toBe('In Progress');
    expect(out.done.name).toBe('Done');
    expect(out.pickup.id).toBe('o2');
    expect(readLog().join('\n')).toMatch(/creating board columns: In Progress, Sloth needs help, Code Review, Approved, Done/);
  });

  it('creates QA only when it is asked for — a board with no QA step gets no column', async () => {
    board('Todo');
    expect((await ensureColumns('PVTSSF_1', asking())).qa).toEqual({ id: '', name: '' });
    expect(sent.map((o) => o.name)).not.toContain('QA');

    board('Todo');
    const out = await ensureColumns('PVTSSF_1', asking({ qa: { id: '', name: 'Ready to QA' } }));
    expect(sent.map((o) => o.name)).toContain('Ready to QA');
    expect(out.qa.name).toBe('Ready to QA');
  });

  it('refuses a board the watched column is not on', async () => {
    board('Backlog', 'Done');
    await expect(ensureColumns('PVTSSF_1', asking({ pickup: { id: '', name: 'Ready' } }))).rejects.toThrow('the watched column "Ready" is not on this board');
    expect(sent).toEqual([]);
  });

  it('says which role it could not resolve when the mutation comes back without it', async () => {
    board('Todo');
    updateReturnsNothing = true;
    await expect(ensureColumns('PVTSSF_1', asking())).rejects.toThrow(/could not resolve the \w+ column/);
  });
});
