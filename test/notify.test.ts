import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDry } from '../server/runner/log';
import { notifyParked } from '../server/runner/notify';
import { COLUMNS, configure, exists, readLog, statePath, wipe } from './harness';

const card = (number: number, status: string, assignees: string[] = []) => ({ number, title: `Issue ${number}`, status, labels: [], assignees });
const posted: { url: string; body: any }[] = [];

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

describe('notifyParked (trigger 7)', () => {
  it('announces each newly parked card once, and again after it left and came back', async () => {
    const parked = [card(1, COLUMNS.needsHelp.name), card(2, COLUMNS.needsHelp.name, ['bob'])];
    await notifyParked(parked);
    expect(posted.map((p) => p.body.issue)).toEqual([1]);
    expect(posted[0].body).toMatchObject({ text: expect.stringContaining('#1 Issue 1'), repo: 'acme/widgets', column: COLUMNS.needsHelp.name });
    expect(exists(statePath('notified', '1'))).toBe(true);
    await notifyParked(parked);
    expect(posted).toHaveLength(1);
    await notifyParked([card(1, COLUMNS.inProgress.name)]);
    expect(exists(statePath('notified', '1'))).toBe(false);
    await notifyParked(parked);
    expect(posted).toHaveLength(2);
  });
  it('leaves no marker when the POST fails, and posts nothing in a dry run', async () => {
    (fetch as any).mockResolvedValueOnce({ ok: false, status: 500, statusText: 'oops' });
    await notifyParked([card(1, COLUMNS.needsHelp.name)]);
    expect(exists(statePath('notified', '1'))).toBe(false);
    expect(readLog().at(-1)).toMatch(/#1 webhook failed: 500 oops/);
    setDry(true);
    await notifyParked([card(1, COLUMNS.needsHelp.name)]);
    expect(posted).toHaveLength(0);
    expect(exists(statePath('notified', '1'))).toBe(false);
    expect(readLog().at(-1)).toMatch(/dry-run: would notify webhook/);
  });
  it('does nothing without a webhook', async () => {
    configure({ helpWebhook: '' });
    await notifyParked([card(1, COLUMNS.needsHelp.name)]);
    expect(posted).toHaveLength(0);
  });
});
