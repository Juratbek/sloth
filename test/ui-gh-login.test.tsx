// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GhLogin as Status } from '../server/config-types';
import GhLogin from '../src/setup/GhLogin';
import { queryKeys } from '../src/lib/query-keys';

/** What the server answers: the GET's status, and each POST's. */
const h = vi.hoisted(() => ({ status: { running: false } as Status, posted: [] as string[] }));
vi.mock('../src/lib/api', () => ({
  fetchJson: async () => h.status,
  postJson: async (url: string) => {
    h.posted.push(url);
    h.status = url.endsWith('/cancel') ? { running: false } : { running: true };
    return h.status;
  },
}));

let client: QueryClient;
let loggedIn = 0;

function mount() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (const key of [queryKeys.setupEnv, queryKeys.setupProjects, queryKeys.health]) client.setQueryData(key, 'cached');
  render(
    <QueryClientProvider client={client}>
      <GhLogin onLoggedIn={() => (loggedIn += 1)} />
    </QueryClientProvider>,
  );
}
const invalidated = () => [queryKeys.setupEnv, queryKeys.setupProjects, queryKeys.health].filter((key) => client.getQueryState(key)?.isInvalidated).length;
const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));
/** The next poll's answer, as the query client hands it to the page. */
const serverSays = async (status: Status) => {
  act(() => client.setQueryData(queryKeys.setupGhLogin, status));
  await settle();
};

beforeEach(() => {
  h.status = { running: false };
  h.posted.length = 0;
  loggedIn = 0;
});
afterEach(cleanup);

describe('the wizard’s Log in button', () => {
  it('ignores the verdict of a login some earlier page ran — an old ok is not this row turning green', async () => {
    h.status = { running: false, ok: true };
    mount();
    await settle();
    expect(screen.queryByText(/Logged in/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Log in' })).toBeTruthy();
    expect(invalidated()).toBe(0);
    expect(loggedIn).toBe(0);
  });

  it('starts the login, shows the code gh printed, and re-reads the environment once gh reports it', async () => {
    mount();
    await settle();
    await userEvent.click(screen.getByRole('button', { name: 'Log in' }));
    await settle();
    expect(h.posted).toEqual(['/api/setup/gh-login']);
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    await serverSays({ running: true, code: '1A2B-3C4D', url: 'https://github.com/login/device' });
    expect(screen.getByText('1A2B-3C4D')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'github.com/login/device' })).toBeTruthy();
    await serverSays({ running: false, ok: true });
    await settle();
    expect(screen.getByText(/Logged in/)).toBeTruthy();
    expect(invalidated()).toBe(3);
    expect(loggedIn).toBe(1);
  });

  it('shows why a login it started failed, and offers the button again', async () => {
    mount();
    await settle();
    await userEvent.click(screen.getByRole('button', { name: 'Log in' }));
    await settle();
    await serverSays({ running: false, error: 'error: authentication timed out' });
    expect(screen.getByText('error: authentication timed out')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Log in' })).toBeTruthy();
    expect(loggedIn).toBe(0);
  });

  it('cancels through the server', async () => {
    h.status = { running: true, code: '1A2B-3C4D', url: 'https://github.com/login/device' };
    mount();
    await settle();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await settle();
    expect(h.posted).toEqual(['/api/setup/gh-login/cancel']);
    expect(screen.getByRole('button', { name: 'Log in' })).toBeTruthy();
    expect(screen.queryByText('1A2B-3C4D')).toBeNull();
  });
});
