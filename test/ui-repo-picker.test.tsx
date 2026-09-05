// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepoConfig, SetupRepo } from '../server/config-types';
import RepoPicker from '../src/setup/RepoPicker';

/**
 * The list of repositories the user ticks Sloth's out of — the wizard's step and Settings show this same
 * component, so what it does with a click is the whole of how a repository is added or dropped.
 */

const h = vi.hoisted(() => ({ repos: [] as SetupRepo[], error: '', pending: false }));
vi.mock('../src/lib/api', () => ({
  fetchJson: async () => {
    if (h.pending) return new Promise(() => {});
    if (h.error) throw new Error(h.error);
    return h.repos;
  },
  postJson: async () => ({}),
}));

const listed = (slug: string, over: Partial<SetupRepo> = {}): SetupRepo => ({
  slug,
  description: '',
  private: false,
  archived: false,
  permission: 'WRITE',
  pushedAt: '2026-09-01T00:00:00Z',
  ...over,
});

const picked = (slug: string): RepoConfig => ({ slug, note: '', root: `~/.sloth/runners/${slug.split('/')[1]}` });

let changed: RepoConfig[][] = [];

function mount(props: { repos?: RepoConfig[]; linked?: string[]; locked?: string } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RepoPicker
        repos={props.repos ?? []}
        onChange={(repos) => changed.push(repos)}
        linked={props.linked ?? []}
        home="~/.sloth"
        locked={props.locked}
      />
    </QueryClientProvider>,
  );
}

const box = (slug: string) => screen.getByRole<HTMLInputElement>('checkbox', { name: slug });
const boxes = () => screen.getAllByRole<HTMLInputElement>('checkbox').map((b) => b.getAttribute('aria-label'));

beforeEach(() => {
  h.repos = [];
  h.error = '';
  h.pending = false;
  changed = [];
});
afterEach(cleanup);

describe('the repository picker', () => {
  it('lists what the account can reach, each as a checkbox with what the repository is', async () => {
    h.repos = [listed('acme/widgets', { description: 'the web app' }), listed('acme/api', { private: true }), listed('acme/attic', { archived: true })];
    mount();
    expect(await screen.findByRole('checkbox', { name: 'acme/widgets' })).toBeTruthy();
    expect(boxes()).toEqual(['acme/widgets', 'acme/api', 'acme/attic']);
    expect(screen.getByText('the web app')).toBeTruthy();
    expect(screen.getByText('private')).toBeTruthy();
    expect(screen.getByText('archived')).toBeTruthy();
    expect(box('acme/widgets').checked).toBe(false);
  });

  it('adds a ticked repository at its default checkout, and drops an unticked one', async () => {
    h.repos = [listed('acme/widgets'), listed('acme/api')];
    mount({ repos: [picked('acme/widgets')] });
    await screen.findByRole('checkbox', { name: 'acme/api' });
    expect(box('acme/widgets').checked).toBe(true);
    await userEvent.click(box('acme/api'));
    expect(changed).toEqual([[picked('acme/widgets'), { slug: 'acme/api', note: '', root: '~/.sloth/runners/api' }]]);
    await userEvent.click(box('acme/widgets'));
    expect(changed[1]).toEqual([]);
  });

  it('will not let the locked repository go — its files on disk carry no repository name', async () => {
    h.repos = [listed('acme/widgets'), listed('acme/api')];
    mount({ repos: [picked('acme/widgets'), picked('acme/api')], locked: 'acme/widgets' });
    await screen.findByRole('checkbox', { name: 'acme/api' });
    expect(box('acme/widgets').disabled).toBe(true);
    expect(box('acme/api').disabled).toBe(false);
    expect(screen.getByText(/cannot be removed/)).toBeTruthy();
  });

  it('does not offer a repository it can only read — Sloth pushes branches and opens PRs', async () => {
    h.repos = [listed('acme/widgets'), listed('other/docs', { permission: 'READ' }), listed('other/triage', { permission: 'TRIAGE' })];
    mount();
    await screen.findByRole('checkbox', { name: 'other/docs' });
    expect(box('other/docs').disabled).toBe(true);
    expect(box('other/triage').disabled).toBe(true);
    expect(box('acme/widgets').disabled).toBe(false);
    expect(screen.getAllByText(/read access only/)).toHaveLength(2);
  });

  it('filters on the slug and on the description, and says how much of the list is left', async () => {
    h.repos = [listed('acme/widgets', { description: 'the web app' }), listed('acme/api', { description: 'the mobile backend' }), listed('acme/attic')];
    mount();
    await screen.findByRole('checkbox', { name: 'acme/attic' });
    await userEvent.type(screen.getByLabelText('Search repositories'), 'WID');
    expect(boxes()).toEqual(['acme/widgets']);
    expect(screen.getByText('1 of 3 shown')).toBeTruthy();
    await userEvent.clear(screen.getByLabelText('Search repositories'));
    await userEvent.type(screen.getByLabelText('Search repositories'), 'mobile');
    expect(boxes()).toEqual(['acme/api']);
  });

  it('still shows a picked repository GitHub did not name, ticked and first, so it can be dropped', async () => {
    h.repos = [listed('acme/widgets')];
    mount({ repos: [picked('gone/repo')] });
    await screen.findByRole('checkbox', { name: 'acme/widgets' });
    expect(boxes()).toEqual(['gone/repo', 'acme/widgets']);
    expect(box('gone/repo').checked).toBe(true);
    expect(screen.getByText('not in your list')).toBeTruthy();
    await userEvent.click(box('gone/repo'));
    expect(changed).toEqual([[]]);
  });

  it('says nothing about a picked repository while the list is still coming — it is waiting, not gone', async () => {
    h.pending = true;
    mount({ repos: [picked('acme/widgets')] });
    expect(box('acme/widgets').checked).toBe(true);
    expect(screen.queryByText('not in your list')).toBeNull();
  });

  it('takes a name typed in for a repository the list has not got, and only a real one', async () => {
    h.repos = [listed('acme/widgets')];
    mount({ repos: [picked('acme/widgets')] });
    await screen.findByRole('checkbox', { name: 'acme/widgets' });
    await userEvent.click(screen.getByRole('button', { name: /Add by name/ }));
    const add = screen.getByRole('button', { name: 'Add' });
    await userEvent.type(screen.getByPlaceholderText('owner/repo'), 'not a repo');
    expect(add.hasAttribute('disabled')).toBe(true);
    await userEvent.clear(screen.getByPlaceholderText('owner/repo'));
    await userEvent.type(screen.getByPlaceholderText('owner/repo'), 'other/tool');
    await userEvent.click(add);
    expect(changed).toEqual([[picked('acme/widgets'), { slug: 'other/tool', note: '', root: '~/.sloth/runners/tool' }]]);
  });

  it('says to log in when that is what the failed reading means', async () => {
    h.error = '`gh` was not found on PATH';
    mount({ repos: [picked('acme/widgets')] });
    expect(await screen.findByText('`gh` was not found on PATH')).toBeTruthy();
    expect(screen.getByText(/Install gh and log in/)).toBeTruthy();
    // The list is unknown, not empty: a picked repository is not called missing off a failed reading.
    expect(screen.queryByText('not in your list')).toBeNull();
  });
});
