import { describe, expect, it } from 'vitest';
import { canAnswer, canOrder, roleOf, sameLogin } from '../server/roles';

const roles = { admin: 'Alice', developers: ['bob', 'Dana'], testers: ['carol'] };

describe('roleOf', () => {
  it('matches logins case-insensitively, as GitHub does', () => {
    expect(roleOf(roles, 'alice')).toBe('admin');
    expect(roleOf(roles, 'BOB')).toBe('developer');
    expect(roleOf(roles, 'dana')).toBe('developer');
    expect(roleOf(roles, 'Carol')).toBe('tester');
  });
  it('is undefined for strangers, empty logins and an empty admin', () => {
    expect(roleOf(roles, 'mallory')).toBeUndefined();
    expect(roleOf(roles, '')).toBeUndefined();
    expect(roleOf({ admin: '', developers: [], testers: [] }, '')).toBeUndefined();
  });
  it('lets the admin win over the other lists', () => {
    expect(roleOf({ ...roles, developers: ['alice'] }, 'alice')).toBe('admin');
  });
});

describe('permissions', () => {
  it('orders come from the admin and the developers only', () => {
    expect(canOrder('admin')).toBe(true);
    expect(canOrder('developer')).toBe(true);
    expect(canOrder('tester')).toBe(false);
    expect(canOrder(undefined)).toBe(false);
  });
  it('every role answers; nobody else does', () => {
    expect(canAnswer('tester')).toBe(true);
    expect(canAnswer(undefined)).toBe(false);
  });
  it('sameLogin ignores case but not accents-as-letters', () => {
    expect(sameLogin('Jurat', 'jurat')).toBe(true);
    expect(sameLogin('jurat', 'jurat2')).toBe(false);
  });
});
