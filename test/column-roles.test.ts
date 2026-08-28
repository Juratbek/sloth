import { describe, expect, it } from 'vitest';
import { columnFor, pickColumn } from '../src/setup/column-roles';

const options = [
  { id: '1', name: 'Backlog' },
  { id: '2', name: 'To do' },
  { id: '3', name: 'In progress' },
  { id: '4', name: 'Blocked' },
  { id: '5', name: 'Review' },
  { id: '6', name: 'Done' },
];

describe('columnFor', () => {
  it('guesses each role from the column names', () => {
    expect(columnFor('pickup', undefined, options).id).toBe('2');
    expect(columnFor('inProgress', undefined, options).id).toBe('3');
    expect(columnFor('needsHelp', undefined, options).id).toBe('4');
    expect(columnFor('codeReview', undefined, options).id).toBe('5');
  });
  it('falls back to a column to create under the default name', () => {
    expect(columnFor('approved', undefined, options)).toEqual({ id: '', name: 'Approved' });
  });
  it('keeps a choice that is still on the board, or one to create', () => {
    expect(columnFor('pickup', { id: '1', name: 'Backlog' }, options).id).toBe('1');
    expect(columnFor('pickup', { id: 'gone', name: 'Gone' }, options).id).toBe('2');
    expect(columnFor('approved', { id: '', name: 'Accepted' }, options)).toEqual({ id: '', name: 'Accepted' });
  });
});

describe('pickColumn', () => {
  it('maps an id to its option, and the empty choice to a column to create', () => {
    expect(pickColumn('codeReview', '5', options)).toEqual({ id: '5', name: 'Review' });
    expect(pickColumn('codeReview', '', options)).toEqual({ id: '', name: 'Code Review' });
  });
});
