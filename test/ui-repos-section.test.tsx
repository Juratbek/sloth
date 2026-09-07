// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG_DEFAULTS } from '../server/config-types';
import type { RepoConfig, SetupRepo, SlothConfig } from '../server/config-types';
import ReposSection from '../src/settings/ReposSection';

/**
 * The Repositories page: the whole list open the moment the page is, a ticked repository showing what it
 * is asked for under its own row, and a Save of its own — the settings shell's bar is out of the way here.
 */

const h = vi.hoisted(() => ({ repos: [] as SetupRepo[] }));
vi.mock('../src/lib/api', () => ({
  fetchJson: async (path: string) => (path === '/api/setup/repos' ? h.repos : {}),
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

const config = (repos: RepoConfig[]): SlothConfig =>
  ({ ...CONFIG_DEFAULTS, version: 1, repos, legacyRepo: repos[0]?.slug ?? '', project: { id: '', number: 0, owner: '', title: '' } }) as unknown as SlothConfig;

let saved = 0;
let discarded = 0;

function mount(props: { repos?: RepoConfig[]; baseline?: RepoConfig[]; saving?: boolean; saveError?: string } = {}) {
  const repos = props.repos ?? [picked('acme/widgets')];
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ReposSection
        draft={config(repos)}
        baseline={config(props.baseline ?? repos)}
        patch={() => {}}
        save={() => saved++}
        discard={() => discarded++}
        saving={props.saving ?? false}
        saveError={props.saveError}
      />
    </QueryClientProvider>,
  );
}

const button = (name: string) => screen.getByRole('button', { name });

beforeEach(() => {
  h.repos = [listed('acme/widgets', { description: 'the web app' }), listed('acme/api')];
  saved = 0;
  discarded = 0;
});
afterEach(cleanup);

describe('the Repositories settings page', () => {
  it('shows the repositories it can reach without a click on anything', async () => {
    mount();
    expect(await screen.findByRole('checkbox', { name: 'acme/api' })).toBeTruthy();
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'acme/widgets' }).checked).toBe(true);
    expect(screen.getByText('the web app')).toBeTruthy();
  });

  it('opens a ticked repository on its checkout and its note, and leaves an unticked one alone', async () => {
    mount();
    await screen.findByRole('checkbox', { name: 'acme/api' });
    expect(screen.getByPlaceholderText('~/.sloth/runners/widgets')).toBeTruthy();
    expect(screen.getByText('Checkout')).toBeTruthy();
    expect(screen.getByText('What it is')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Clone' })).toBeTruthy();
    expect(screen.queryByPlaceholderText('~/.sloth/runners/api')).toBeNull();
  });

  it('saves from the page itself, and only once there is something to save', async () => {
    const nothing = mount();
    await screen.findByRole('checkbox', { name: 'acme/api' });
    expect(button('Save').hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('Everything here is saved.')).toBeTruthy();
    nothing.unmount();

    mount({ repos: [picked('acme/widgets'), picked('acme/api')], baseline: [picked('acme/widgets')] });
    await screen.findByRole('checkbox', { name: 'acme/api' });
    expect(screen.getByText('Unsaved changes.')).toBeTruthy();
    expect(button('Save').hasAttribute('disabled')).toBe(false);
    await userEvent.click(button('Save'));
    expect(saved).toBe(1);
    await userEvent.click(button('Discard'));
    expect(discarded).toBe(1);
  });

  it('says what went wrong when the save did, and says nothing while it is going', async () => {
    const failed = mount({ repos: [picked('acme/widgets'), picked('acme/api')], baseline: [picked('acme/widgets')], saveError: 'the config is not valid' });
    await screen.findByRole('checkbox', { name: 'acme/api' });
    expect(screen.getByText('the config is not valid')).toBeTruthy();
    failed.unmount();

    mount({ repos: [picked('acme/widgets'), picked('acme/api')], baseline: [picked('acme/widgets')], saving: true });
    await screen.findByRole('checkbox', { name: 'acme/api' });
    expect(button('Saving…').hasAttribute('disabled')).toBe(true);
  });
});
