import type { Roles } from './config-types';

/**
 * Who may say what to Sloth. `admin` orders anything, on any card — work, board moves, closing an
 * issue. A `developer` orders work in the scope of the issue they comment on. A `tester` answers the
 * questions a parked card asks and may ask for status, but never orders. Everyone else is ignored.
 */
export type Role = 'admin' | 'developer' | 'tester';

/** GitHub logins are case-insensitive. */
export const sameLogin = (a: string, b: string) => a.localeCompare(b, 'en', { sensitivity: 'accent' }) === 0;
const has = (list: string[], login: string) => list.some((l) => sameLogin(l, login));

/** The role of a GitHub login, or undefined for someone with none. Logins compare case-insensitively, as GitHub does. */
export function roleOf(roles: Roles, login: string): Role | undefined {
  if (!login) return undefined;
  if (roles.admin && sameLogin(roles.admin, login)) return 'admin';
  if (has(roles.developers, login)) return 'developer';
  if (has(roles.testers, login)) return 'tester';
  return undefined;
}

/** Orders come from the admin and the developers. */
export const canOrder = (role: Role | undefined): boolean => role === 'admin' || role === 'developer';

/** Every role may answer a parked card's questions and ask for status. */
export const canAnswer = (role: Role | undefined): boolean => role !== undefined;
