import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDry } from '../server/runner/log';
import { boardEvents } from '../server/runner/notify-events';
import { notify } from '../server/runner/notify';
import { COLUMNS, card, configure, exists, readLog, statePath, wipe } from './harness';

const posted: { url: string; body: any }[] = [];
const events = () => posted.map((p) => `${p.body.event} #${p.body.issue}`);
const ALL = ['needsHelp', 'codeReview', 'finalPassed', 'finalFailed', 'merged', 'stopped', 'usageLimit'];

beforeEach(() => {
  configure({ helpWebhook: 'https://hooks.example.com/x' });
  wipe();
  posted.length = 0;
  setDry(false);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    posted.push({ url, body: JSON.parse(String(init.body)) });
    return { ok: true, status: 200, statusText: 'OK' };
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe('boardEvents: needs help', () => {
  it('announces each newly parked card once, and again after it left and came back', async () => {
    const parked = [card(1, COLUMNS.needsHelp.name), card(2, COLUMNS.needsHelp.name, { labels: ['Sloth: skip'] })];
    await boardEvents(parked);
    expect(posted.map((p) => p.body.issue)).toEqual([1]);
    expect(posted[0].body).toMatchObject({
      event: 'needsHelp',
      text: expect.stringContaining('#1 Issue 1'),
      content: expect.stringContaining('https://github.com/acme/widgets/issues/1'),
      repo: 'acme/widgets',
      column: COLUMNS.needsHelp.name,
    });
    expect(exists(statePath('notified', '1'))).toBe(true);
    await boardEvents(parked);
    expect(posted).toHaveLength(1);
    await boardEvents([card(1, COLUMNS.inProgress.name)]);
    expect(exists(statePath('notified', '1'))).toBe(false);
    await boardEvents(parked);
    expect(posted).toHaveLength(2);
  });
  it('leaves no marker when the POST fails, and posts nothing in a dry run', async () => {
    (fetch as any).mockResolvedValueOnce({ ok: false, status: 500, statusText: 'oops' });
    await boardEvents([card(1, COLUMNS.needsHelp.name)]);
    expect(exists(statePath('notified', '1'))).toBe(false);
    expect(readLog().at(-1)).toMatch(/#1 webhook failed: 500 oops/);
    setDry(true);
    await boardEvents([card(1, COLUMNS.needsHelp.name)]);
    expect(posted).toHaveLength(0);
    expect(exists(statePath('notified', '1'))).toBe(false);
    expect(readLog().at(-1)).toMatch(/dry-run: would notify webhook/);
  });
  it('does nothing without a webhook, or with the event turned off', async () => {
    configure({ helpWebhook: '' });
    await boardEvents([card(1, COLUMNS.needsHelp.name)]);
    expect(posted).toHaveLength(0);
    configure({ helpWebhook: 'https://hooks.example.com/x', webhookEvents: [] });
    await boardEvents([card(1, COLUMNS.needsHelp.name)]);
    expect(posted).toHaveLength(0);
  });
});

describe("boardEvents: the rest of a card's life", () => {
  beforeEach(() => configure({ helpWebhook: 'https://hooks.example.com/x', webhookEvents: ALL }));

  it('announces Code Review, a passing final review and a closed issue once each', async () => {
    fs.mkdirSync(statePath('finished'), { recursive: true });
    fs.writeFileSync(statePath('finished', '3'), '');
    const board = [
      card(1, COLUMNS.codeReview.name),
      card(2, COLUMNS.approved.name, { labels: ['Fable: approved'] }),
      card(3, COLUMNS.done.name, { closed: true }),
      // Closed, but not by anything Sloth did — the board is full of those.
      card(4, COLUMNS.done.name, { closed: true }),
    ];
    await boardEvents(board);
    expect(events()).toEqual(['codeReview #1', 'finalPassed #2', 'merged #3']);
    expect(exists(statePath('notified', 'codeReview', '1'))).toBe(true);
    await boardEvents(board);
    expect(posted).toHaveLength(3);
  });

  it('announces the label going as the failing verdict, once', async () => {
    const passed = [card(2, COLUMNS.approved.name, { labels: ['Fable: approved'] })];
    await boardEvents(passed);
    posted.length = 0;
    await boardEvents([card(2, COLUMNS.inProgress.name)]);
    expect(events()).toEqual(['finalFailed #2']);
    expect(posted[0].body.text).toMatch(/lost its "Fable: approved" label/);
    await boardEvents([card(2, COLUMNS.inProgress.name)]);
    expect(posted).toHaveLength(1);
  });

  it('says nothing when a passed card is filed to Done with its label still on', async () => {
    const passed = [card(2, COLUMNS.approved.name, { labels: ['Fable: approved'] })];
    await boardEvents(passed);
    posted.length = 0;
    // Trigger 6 files the merged card away; the label is still there, so its review did not fail.
    fs.mkdirSync(statePath('finished'), { recursive: true });
    fs.writeFileSync(statePath('finished', '2'), '');
    await boardEvents([card(2, COLUMNS.done.name, { closed: true, labels: ['Fable: approved'] })]);
    expect(events()).toEqual(['merged #2']);
    expect(exists(statePath('notified', 'finalPassed', '2'))).toBe(false);
  });

  it('raises finalFailed for someone who subscribed to it but not to finalPassed', async () => {
    configure({ helpWebhook: 'https://hooks.example.com/x', webhookEvents: ['finalFailed'] });
    // The pass is not announced, but it is still recorded — otherwise its going could never be noticed.
    await boardEvents([card(2, COLUMNS.approved.name, { labels: ['Fable: approved'] })]);
    expect(posted).toHaveLength(0);
    expect(exists(statePath('notified', 'finalPassed', '2'))).toBe(true);
    await boardEvents([card(2, COLUMNS.inProgress.name)]);
    expect(events()).toEqual(['finalFailed #2']);
  });

  it('keeps the needs-help markers apart from the per-event directories', async () => {
    await boardEvents([card(1, COLUMNS.needsHelp.name), card(5, COLUMNS.codeReview.name)]);
    expect(fs.readdirSync(statePath('notified')).sort()).toEqual(['1', 'codeReview']);
    // The old numeric markers survive a tick that has no needs-help card of that number.
    await boardEvents([card(1, COLUMNS.needsHelp.name)]);
    expect(exists(statePath('notified', '1'))).toBe(true);
    expect(exists(statePath('notified', 'codeReview'))).toBe(true);
  });
});

describe('notify', () => {
  it('sends a point event with no issue, and says which event it was', async () => {
    configure({ helpWebhook: 'https://hooks.example.com/x', webhookEvents: ALL });
    expect(await notify('usageLimit', { text: 'review-9 stopped on a Claude usage limit' })).toBe(true);
    expect(posted[0].body).toMatchObject({ event: 'usageLimit', issue: null, url: 'https://github.com/acme/widgets' });
    expect(await notify('stopped', { issue: 7, text: 'Sloth stopped work on #7' })).toBe(true);
    expect(posted[1].body.text).toBe('Sloth stopped work on #7 — https://github.com/acme/widgets/issues/7');
  });
  it('says nothing for an event nobody asked for', async () => {
    expect(await notify('stopped', { issue: 7, text: 'x' })).toBe(false);
    expect(posted).toHaveLength(0);
  });
});
