// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
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

function mount(props: { repos?: RepoConfig[]; linked?: string[]; locked?: string; details?: (repo: RepoConfig, at: number) => ReactNode; bounded?: boolean } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RepoPicker
        repos={props.repos ?? []}
        onChange={(repos) => changed.push(repos)}
        linked={props.linked ?? []}
        home="~/.sloth"
        locked={props.locked}
        details={props.details}
        bounded={props.bounded}
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

  it('leaves a repository where the list put it when it is ticked', async () => {
    h.repos = [listed('acme/widgets'), listed('acme/api'), listed('acme/attic')];
    mount({ repos: [picked('acme/api')] });
    await screen.findByRole('checkbox', { name: 'acme/attic' });
    expect(boxes()).toEqual(['acme/widgets', 'acme/api', 'acme/attic']);
  });

  it("puts the board's own repositories first, whether they are picked or not", async () => {
    h.repos = [listed('acme/widgets'), listed('acme/api'), listed('acme/attic')];
    mount({ linked: ['acme/attic'] });
    await screen.findByRole('checkbox', { name: 'acme/widgets' });
    expect(boxes()).toEqual(['acme/attic', 'acme/widgets', 'acme/api']);
  });

  it('filters by whether a repository is selected, together with the search', async () => {
    h.repos = [listed('acme/widgets'), listed('acme/api'), listed('acme/attic')];
    mount({ repos: [picked('acme/api')] });
    await screen.findByRole('checkbox', { name: 'acme/attic' });
    await userEvent.click(screen.getByRole('button', { name: 'Selected' }));
    expect(boxes()).toEqual(['acme/api']);
    expect(screen.getByText('1 of 3 shown')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Selected' }).getAttribute('aria-pressed')).toBe('true');
    await userEvent.click(screen.getByRole('button', { name: 'Not selected' }));
    expect(boxes()).toEqual(['acme/widgets', 'acme/attic']);
    await userEvent.type(screen.getByLabelText('Search repositories'), 'attic');
    expect(boxes()).toEqual(['acme/attic']);
    await userEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(boxes()).toEqual(['acme/attic']);
  });

  it('takes every repository it may write to when the all-repositories switch goes on', async () => {
    h.repos = [listed('acme/widgets'), listed('acme/api'), listed('acme/attic', { archived: true }), listed('other/docs', { permission: 'READ' })];
    mount({ repos: [picked('acme/api')] });
    await screen.findByRole('checkbox', { name: 'other/docs' });
    const all = screen.getByRole('switch', { name: 'All repositories' });
    expect(all.getAttribute('aria-checked')).toBe('false');
    await userEvent.click(all);
    expect(changed[0].map((r) => r.slug)).toEqual(['acme/api', 'acme/widgets']);
  });

  it('gives every repository back when the switch goes off, keeping the locked one', async () => {
    h.repos = [listed('acme/widgets'), listed('acme/api')];
    mount({ repos: [picked('acme/widgets'), picked('acme/api')], locked: 'acme/widgets' });
    // Both rows are there off the picked list alone; the switch only knows its answer once the list is in.
    const all = screen.getByRole('switch', { name: 'All repositories' });
    await waitFor(() => expect(all.getAttribute('aria-checked')).toBe('true'));
    await userEvent.click(all);
    expect(changed).toEqual([[picked('acme/widgets')]]);
  });

  it('does not offer the switch a list it has not read yet', async () => {
    h.pending = true;
    mount();
    expect(screen.getByRole<HTMLButtonElement>('switch', { name: 'All repositories' }).disabled).toBe(true);
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

  it('still shows a picked repository GitHub did not name, ticked and last, so it can be dropped', async () => {
    h.repos = [listed('acme/widgets')];
    mount({ repos: [picked('gone/repo')] });
    await screen.findByRole('checkbox', { name: 'acme/widgets' });
    expect(boxes()).toEqual(['acme/widgets', 'gone/repo']);
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

  it('opens a picked row on what the page gives it, and leaves an unticked one shut', async () => {
    h.repos = [listed('acme/widgets'), listed('acme/api')];
    mount({ repos: [picked('acme/widgets')], details: (repo, at) => <p>{`options for ${repo.slug} at ${at}`}</p> });
    await screen.findByRole('checkbox', { name: 'acme/api' });
    expect(screen.getByText('options for acme/widgets at 0')).toBeTruthy();
    expect(screen.queryByText(/options for acme\/api/)).toBeNull();
  });

  it('folds a picked row away behind its chevron and opens it again, leaving the tick alone', async () => {
    h.repos = [listed('acme/widgets'), listed('acme/api')];
    mount({ repos: [picked('acme/widgets')], details: (repo) => <p>{`options for ${repo.slug}`}</p> });
    await screen.findByRole('checkbox', { name: 'acme/api' });
    expect(screen.getByText('options for acme/widgets')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Collapse acme/widgets' }));
    expect(screen.queryByText('options for acme/widgets')).toBeNull();
    // Folded, the header still says where the checkout goes.
    expect(screen.getByText('~/.sloth/runners/widgets')).toBeTruthy();
    // The chevron is outside the label, so folding is not ticking.
    expect(box('acme/widgets').checked).toBe(true);
    expect(changed).toEqual([]);

    await userEvent.click(screen.getByRole('button', { name: 'Expand acme/widgets' }));
    expect(screen.getByText('options for acme/widgets')).toBeTruthy();
    expect(screen.queryByText('~/.sloth/runners/widgets')).toBeNull();
  });

  it('gives the chevron only to a row that has something to fold', async () => {
    h.repos = [listed('acme/widgets'), listed('acme/api')];
    mount({ repos: [picked('acme/widgets')], details: (repo) => <p>{`options for ${repo.slug}`}</p> });
    await screen.findByRole('checkbox', { name: 'acme/api' });
    expect(screen.getByRole('button', { name: 'Collapse acme/widgets' }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.queryByRole('button', { name: /acme\/api/ })).toBeNull();
  });

  it('puts the list in a scroll box of its own only where the page asks for one', async () => {
    h.repos = [listed('acme/widgets')];
    const open = mount();
    await screen.findByRole('checkbox', { name: 'acme/widgets' });
    expect(open.container.querySelector('[class*="max-h-"]')).toBeNull();
    cleanup();
    const boxed = mount({ bounded: true });
    await screen.findByRole('checkbox', { name: 'acme/widgets' });
    expect(boxed.container.querySelector('[class*="max-h-"]')).toBeTruthy();
  });
});
