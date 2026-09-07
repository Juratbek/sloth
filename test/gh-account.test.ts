import { describe, expect, it } from 'vitest';
import { accountFrom } from '../server/setup';

describe('the GitHub login the wizard prefills', () => {
  it('is the account gh auth status names', () => {
    expect(accountFrom('github.com\n  ✓ Logged in to github.com account Juratbek (keyring)\n  - Active account: true\n')).toBe('Juratbek');
  });

  it('is still read when the token check behind the line fails', () => {
    expect(accountFrom('github.com\n  X Failed to log in to github.com account Juratbek (keyring)\n  - The token in keyring is invalid.\n')).toBe('Juratbek');
  });

  it('is the active account when several are logged in', () => {
    expect(accountFrom('github.com\n  ✓ Logged in to github.com account alice (keyring)\n  - Active account: true\n\n  ✓ Logged in to github.com account bob (keyring)\n  - Active account: false\n')).toBe('alice');
  });

  it('is nothing when nobody is logged in', () => {
    expect(accountFrom('You are not logged into any GitHub hosts. To log in, run: gh auth login\n')).toBeUndefined();
  });
});
