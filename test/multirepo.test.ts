import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cardInfo, moveFromSession } from '../server/board-api';
import { ensureCheckout } from '../server/checkout';
import { cfg } from '../server/config';
import { isConfigured, legacyRepo, repoRoot, repoSlugs, tag, transcriptsDirs } from '../server/repos';
import { fetchBoard } from '../server/runner/board';
import { issueOf } from '../server/runner/board-trello';
import { setSnapshot } from '../server/runner/board-snapshot';
import { setDry } from '../server/runner/log';
import { chooseRepo, parseChoice } from '../server/runner/repo-choice';
import { prune } from '../server/runner/retention';
import { dirOf, issueDir, parseRunName, runName } from '../server/runner/session-dirs';
import { sessionEnv } from '../server/runner/session-env';
import { leaseSlot, releaseSlot, slotOf, slotWorktree } from '../server/runner/slots';
import type { TrelloCard } from '../server/trello';
import { ensureWebhook, forgetWebhook } from '../server/webhook';
import { called, onCommand, onGh, resetGh } from './gh-mock';
import { card, configure, readLog, root, statePath, wipe } from './harness';

vi.mock('../server/runner/gh', () => import('./gh-mock'));
vi.mock('node:child_process', () => import('./child-process-mock'));

/**
 * One board, two repositories. `acme/widgets` is the one an older config named — its names on disk stay
 * as they were; `acme/api` came second, and everything of its carries `@acme~api`.
 */

const API = 'acme/api';
const WIDGETS = 'acme/widgets';
const api = (number: number) => ({ repo: API, number });
const roots = () => ({ widgets: path.join(root(), 'runner'), api: path.join(root(), 'runner-api') });

const two = (over: Record<string, unknown> = {}) =>
  configure({
    repos: [
      { slug: WIDGETS, note: 'the web app', root: roots().widgets },
      { slug: API, note: 'the JSON API the app calls', root: roots().api },
    ],
    publicUrl: 'https://sloth.example',
    ...over,
  });

beforeEach(() => {
  two();
  wipe();
  resetGh();
  setDry(false);
  forgetWebhook();
});

describe('a second repository', () => {
  it('is configured beside the first, with the first as the legacy one and a checkout each', () => {
    expect(repoSlugs()).toEqual([WIDGETS, API]);
    expect(legacyRepo()).toBe(WIDGETS);
    expect(repoRoot(API)).toBe(roots().api);
    expect(cfg().title).toBe('Sloth · widgets · api');
    // Two checkouts, two transcript directories — Claude Code files them by cwd.
    expect(new Set(transcriptsDirs()).size).toBe(2);
    // A repository no longer configured still has a place, so its leftovers can be swept.
    expect(repoRoot('acme/gone')).toBe(path.join(cfg().runnersDir, 'gone'));
  });

  it('names its runs, markers and worktrees with the repository, and reads them back', () => {
    expect(path.basename(issueDir({ repo: WIDGETS, number: 12 }))).toBe('issue-12');
    expect(path.basename(issueDir(api(12)))).toBe('issue-12@acme~api');
    expect(runName({ kind: 'qa', target: 7, repo: API })).toBe('qa-7@acme~api');
    expect(parseRunName('approved-30@acme~api')).toEqual({ kind: 'approved', target: 30, repo: API });
    expect(parseRunName('issue-12')).toEqual({ kind: 'issue', target: 12, repo: WIDGETS });
    expect(parseRunName('slot-1')).toBeUndefined();
    expect(tag('42-abc', API)).toBe('42-abc@acme~api');
    expect(slotWorktree('slot-1', WIDGETS)).toBe(path.join(cfg().worktreesDir, 'slot-1'));
    expect(slotWorktree('slot-1', API)).toBe(path.join(cfg().worktreesDir, 'slot-1@acme~api'));
  });

  it('is cloned like the first when its checkout is missing, and the health of both is one answer', async () => {
    fs.rmSync(roots().api, { recursive: true, force: true });
    onCommand(/^gh repo clone/, ({ args }) => {
      fs.mkdirSync(path.join(args[3], '.git'), { recursive: true });
      return '';
    });
    expect(await ensureCheckout()).toBe(true);
    expect(called(/^gh repo clone/).map((c) => c.args.slice(2))).toEqual([[API, roots().api]]);
  });

  it('is the same repository however its slug is cased — GitHub reads the two as one', () => {
    expect(isConfigured('ACME/API')).toBe(true);
    expect(tag('issue-3', 'Acme/Widgets')).toBe('issue-3');
  });
});

describe('the board with two repositories', () => {
  const item = (number: number, repo: string, status = 'Todo') => ({
    fieldValueByName: { name: status },
    content: { __typename: 'Issue', number, title: `Issue ${number}`, repository: { nameWithOwner: repo }, labels: { nodes: [] }, assignees: { nodes: [] } },
  });

  it('keeps the cards of both, tells them apart by repository, and leaves a foreign repository’s alone — said once', async () => {
    onGh(/api graphql/, { data: { node: { items: { pageInfo: { hasNextPage: false }, nodes: [item(12, WIDGETS), item(12, API), item(3, 'someone/else')] } } } });
    const board = await fetchBoard();
    expect(board?.map((i) => [i.repo, i.number])).toEqual([
      [WIDGETS, 12],
      [API, 12],
    ]);
    await fetchBoard();
    expect(readLog().filter((l) => /someone\/else/.test(l))).toHaveLength(1);
  });

  it('files a card under the config’s spelling of its repository, whatever case GitHub answers in', async () => {
    onGh(/api graphql/, { data: { node: { items: { pageInfo: { hasNextPage: false }, nodes: [item(5, 'Acme/API')] } } } });
    expect((await fetchBoard())?.map((i) => [i.repo, i.number])).toEqual([[API, 5]]);
  });

  it('reads a Trello card’s issue off an attachment of any repository before a description of any', () => {
    const trello = (over: Partial<TrelloCard>): TrelloCard => ({ id: 'c1', name: 'Card', desc: '', idList: 'l', pos: 1, closed: false, shortUrl: 'https://trello.com/c/c1', labels: [], attachments: [], ...over });
    const attached = trello({ attachments: [{ url: 'https://github.com/acme/api/issues/5', name: 'issue' }], desc: 'like https://github.com/acme/widgets/issues/1 did' });
    expect(issueOf(attached)).toEqual(api(5));
    expect(issueOf(trello({ desc: 'see https://github.com/acme/api/issues/5' }))).toEqual(api(5));
  });

  it('answers the board API for the repository the session names, and refuses one that is not Sloth’s', async () => {
    setSnapshot([card(12, 'Todo'), card(12, 'Code Review', { repo: API })]);
    expect((await cardInfo({ repo: WIDGETS, number: 12 })).column).toBe('Todo');
    expect((await cardInfo(api(12))).column).toBe('Code Review');
    expect(await moveFromSession({ issue: 12, column: 'Todo', repo: 'someone/else' })).toMatchObject({ ok: false, error: expect.stringMatching(/not one of Sloth's repositories/) });
  });
});

describe('slots with two repositories', () => {
  it('makes the worktree of the run’s own repository in the slot, from that repository’s checkout', async () => {
    expect(await leaseSlot({ kind: 'issue', target: 12, repo: API })).toBe('slot-1');
    const add = called(/worktree add/);
    expect(add).toHaveLength(1);
    expect(add[0].args.slice(0, 2)).toEqual(['-C', roots().api]);
    expect(add[0].args).toContain(slotWorktree('slot-1', API));
    expect(fs.readFileSync(statePath('slots', 'slot-1'), 'utf8')).toBe('issue-12@acme~api');
    expect(slotOf({ kind: 'issue', target: 12, repo: API })).toBe('slot-1');
    expect(slotOf({ kind: 'issue', target: 12, repo: WIDGETS })).toBeUndefined();
  });

  it('detaches every worktree of the slot when the run gives it back', async () => {
    await leaseSlot({ kind: 'issue', target: 12, repo: API });
    fs.mkdirSync(slotWorktree('slot-1', API), { recursive: true });
    fs.mkdirSync(slotWorktree('slot-1', WIDGETS), { recursive: true });
    await releaseSlot({ kind: 'issue', target: 12, repo: API });
    expect(called(/checkout -q --detach/).map((c) => c.args[1]).sort()).toEqual([slotWorktree('slot-1', WIDGETS), slotWorktree('slot-1', API)].sort());
  });

  it('tells a session about every repository, with its worktree in this slot, and works in its own', () => {
    const env = sessionEnv(dirOf({ kind: 'issue', target: 12, repo: API }), { repo: API, issue: 12 }, 'opus', false, { worktree: 'slot-2' });
    expect(env.SLOTH_REPO).toBe(API);
    expect(env.SLOTH_ISSUE_REPO).toBe(API);
    expect(env.SLOTH_RUNNER_ROOT).toBe(roots().api);
    expect(env.SLOTH_WORKTREE).toBe(slotWorktree('slot-2', API));
    expect(env.SLOTH_SLOT).toBe('slot-2');
    expect(JSON.parse(env.SLOTH_REPOS!)).toEqual([
      { slug: WIDGETS, note: 'the web app', root: roots().widgets, worktree: slotWorktree('slot-2', WIDGETS) },
      { slug: API, note: 'the JSON API the app calls', root: roots().api, worktree: slotWorktree('slot-2', API) },
    ]);
    // A review of a PR in the API that closes an issue in the app: the issue's repository travels beside the PR's.
    const review = sessionEnv(dirOf({ kind: 'approved', target: 30, repo: API }), { repo: API, pr: 30, issue: 12, issueRepo: WIDGETS }, 'fable', false);
    expect([review.SLOTH_REPO, review.SLOTH_ISSUE_REPO]).toEqual([API, WIDGETS]);
  });

  it('sweeps the slot worktree of a repository that is no longer configured, through that repository’s checkout', async () => {
    two({ keepDays: 30, maxActive: 2 });
    fs.mkdirSync(path.join(cfg().worktreesDir, 'slot-1'), { recursive: true });
    fs.mkdirSync(path.join(cfg().worktreesDir, 'slot-1@acme~api'), { recursive: true });
    fs.mkdirSync(path.join(cfg().worktreesDir, 'slot-1@acme~gone'), { recursive: true });
    await prune();
    expect(called(/worktree remove/).map((c) => c.args)).toEqual([['-C', path.join(cfg().runnersDir, 'gone'), 'worktree', 'remove', path.join(cfg().worktreesDir, 'slot-1@acme~gone'), '--force']]);
    // The lease is the slot's: a worktree of a gone repository leaving does not take the slot's lease with it.
    expect(fs.existsSync(path.join(cfg().worktreesDir, 'slot-1@acme~api'))).toBe(true);
  });

  it('leaves the slot’s warm stack standing when a gone repository’s worktree goes — unless the stack was that repository’s app', async () => {
    two({ keepDays: 30, maxActive: 2 });
    fs.mkdirSync(statePath('slots'), { recursive: true });
    const warm = (repo: string) => fs.writeFileSync(statePath('slots', 'slot-1.warm'), JSON.stringify({ run: 'issue-3', repo, dev: [], redis: [], at: 0 }));
    fs.mkdirSync(path.join(cfg().worktreesDir, 'slot-1@acme~gone'), { recursive: true });
    warm(WIDGETS);
    await prune();
    expect(fs.existsSync(statePath('slots', 'slot-1.warm'))).toBe(true);
    fs.mkdirSync(path.join(cfg().worktreesDir, 'slot-1@acme~gone'), { recursive: true });
    warm('acme/gone');
    fs.rmSync(statePath('pruned_at'), { force: true });
    await prune();
    expect(fs.existsSync(statePath('slots', 'slot-1.warm'))).toBe(false);
    expect(readLog().join('\n')).toMatch(/warm stack of slot-1 taken down \(acme\/gone is no longer/);
  });
});

describe('placing a card that names no issue', () => {
  it('takes the repository the card names — its slug, or its bare name when only one has it', async () => {
    expect(await chooseRepo('Fix the login form', 'The form in acme/api returns 500')).toEqual({ slug: API, reason: `the card names ${API}` });
    expect(await chooseRepo('api: rate limit /users', '')).toEqual({ slug: API, reason: 'the card names api' });
    expect(await chooseRepo('Widgets crash on save', '')).toEqual({ slug: WIDGETS, reason: 'the card names widgets' });
  });

  it('reads the model’s answer for a repository it names, last line first, with its reason', () => {
    expect(parseChoice('Thinking…\nacme/api — the endpoint lives there')).toEqual({ slug: API, reason: 'the endpoint lives there' });
    expect(parseChoice('ACME/WIDGETS')).toEqual({ slug: WIDGETS, reason: 'the model picked it' });
    expect(parseChoice('no idea')).toBeUndefined();
  });

  it('takes the first repository in a dry run rather than asking a model', async () => {
    setDry(true);
    expect((await chooseRepo('Something vague', '')).slug).toBe(WIDGETS);
  });
});

describe('the webhook with two repositories', () => {
  it('points one hook per repository at the same address, and reports the one that refused', async () => {
    onCommand(/^gh api repos\/acme\/widgets\/hooks$/, []);
    onCommand(/^gh api repos\/acme\/api\/hooks$/, []);
    onCommand(/-X POST repos\/acme\/widgets\/hooks/, '42');
    onCommand(/-X POST repos\/acme\/api\/hooks/, '43');
    const status = await ensureWebhook();
    expect(status).toMatchObject({ state: 'active', hookId: 42, hookIds: { [WIDGETS]: 42, [API]: 43 } });
    resetGh();
    forgetWebhook();
    onCommand(/^gh api repos\/acme\/widgets\/hooks$/, [{ id: 42, config: { url: 'https://sloth.example/api/hooks/github' } }]);
    onCommand(/^gh api repos\/acme\/api\/hooks$/, { ok: false, out: '', err: 'gh: Not Found (HTTP 404)' });
    const failed = await ensureWebhook();
    expect(failed.state).toBe('failed');
    expect(failed.reason).toMatch(/^acme\/api: .*HTTP 404/);
    expect(failed.hookIds).toEqual({ [WIDGETS]: 42 });
  });

  it('gives the second repository its hook when the first refuses', async () => {
    onCommand(/^gh api repos\/acme\/widgets\/hooks$/, { ok: false, out: '', err: 'gh: Not Found (HTTP 404)' });
    onCommand(/^gh api repos\/acme\/api\/hooks$/, []);
    onCommand(/-X POST repos\/acme\/api\/hooks/, '43');
    const status = await ensureWebhook();
    expect(status).toMatchObject({ state: 'failed', reason: expect.stringMatching(/^acme\/widgets: /), hookIds: { [API]: 43 } });
  });
});
