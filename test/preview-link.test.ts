import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { body, fileOf, linkOf, post, readPreviewFile, when } from '../server/runner/preview-link';
import type { PreviewState } from '../server/types';
import { called, fail, onGh, resetGh } from './gh-mock';
import { configure, makeSession, readLog, root, wipe } from './harness';

vi.mock('../server/runner/gh', () => import('./gh-mock'));

/**
 * What a preview looks like from outside the machine: the file the session wrote, the link that carries
 * the guard's key, and the one comment that is written once and edited ever after.
 */

const state = (over: Partial<PreviewState> = {}): PreviewState => ({
  issue: 42,
  pr: 100,
  url: 'https://calm-sloth-42.trycloudflare.com',
  key: 'k3y',
  startedAt: 1_700_000_000,
  expiresAt: 1_700_086_400,
  ...over,
});

/** The file a session leaves behind when it hands its app over. */
const wrote = (issue: number, contents: string) => {
  makeSession('issue', issue);
  fs.writeFileSync(fileOf(issue), contents);
};

beforeEach(() => {
  configure({ previewHours: 24 });
  wipe();
  resetGh();
});

describe('fileOf, when and linkOf', () => {
  it('name the session’s hand-over file, an expiry a human reads and the link the guard wants', () => {
    expect(fileOf(42)).toBe(path.join(root(), 'sessions', 'issue-42', 'preview.json'));
    expect(when(1_700_086_400)).toBe('2023-11-15 22:13 UTC');
    expect(linkOf(state())).toBe('https://calm-sloth-42.trycloudflare.com/?sloth_key=k3y');
  });
});

describe('readPreviewFile', () => {
  it('takes the one local address the app answers on, without its trailing slash', () => {
    wrote(42, JSON.stringify({ url: 'http://localhost:3000/' }));
    expect(readPreviewFile(42)).toEqual({ url: 'http://localhost:3000', login: undefined });
    wrote(43, JSON.stringify({ url: 'http://127.0.0.1:8080' }));
    expect(readPreviewFile(43)).toMatchObject({ url: 'http://127.0.0.1:8080' });
  });

  it('keeps the sign-in notes, trimmed and capped, so one runaway file cannot become the comment', () => {
    wrote(42, JSON.stringify({ url: 'http://localhost:3000', login: '  admin@example.com / hunter2  ' }));
    expect(readPreviewFile(42)?.login).toBe('admin@example.com / hunter2');
    wrote(43, JSON.stringify({ url: 'http://localhost:3000', login: 'x'.repeat(5000) }));
    expect(readPreviewFile(43)?.login).toHaveLength(3000);
  });

  it('refuses anything that is not a local app: the tunnel is Sloth’s to open, not the session’s', () => {
    for (const [issue, url] of [[1, 'https://evil.example.com'], [2, 'http://localhost'], [3, 'http://192.168.1.5:3000']] as const) {
      wrote(issue, JSON.stringify({ url }));
      expect(readPreviewFile(issue)).toBeUndefined();
    }
  });

  it('is nothing at all for a run that wrote no file, or wrote a broken one', () => {
    expect(readPreviewFile(99)).toBeUndefined();
    wrote(42, 'not json');
    expect(readPreviewFile(42)).toBeUndefined();
    wrote(43, JSON.stringify({ url: 3000 }));
    expect(readPreviewFile(43)).toBeUndefined();
  });
});

describe('body', () => {
  it('leads with the link, says when it dies and for how long, and appends the sign-in notes', () => {
    const text = body(state(), { url: 'http://localhost:3000', login: 'admin@example.com / hunter2' });
    expect(text.split('\n')[0]).toBe('**Sloth:** Preview of this PR: https://calm-sloth-42.trycloudflare.com/?sloth_key=k3y');
    expect(text).toContain('**2023-11-15 22:13 UTC** (24 h)');
    expect(text.trimEnd().endsWith('admin@example.com / hunter2')).toBe(true);
  });

  it('says nothing about signing in when the session left no notes', () => {
    expect(body(state(), { url: 'http://localhost:3000' })).not.toContain('sign in');
  });
});

describe('post', () => {
  it('opens the comment on the PR the run pushed, and remembers the id it was given', async () => {
    onGh(/issues\/100\/comments/, '55501');
    const s = state();
    expect(await post(42, s, 'the body')).toBe(true);
    expect(called(/^gh api repos\/acme\/widgets\/issues\/100\/comments -f body=the body/)).toHaveLength(1);
    expect(s.commentId).toBe(55501);
  });

  it('falls back to the issue when the run opened no PR', async () => {
    const s = state({ pr: undefined });
    await post(42, s, 'the body');
    expect(called(/issues\/42\/comments/)).toHaveLength(1);
  });

  it('edits the one comment already there rather than posting a second', async () => {
    const s = state({ commentId: 55501 });
    await post(42, s, 'a new address');
    expect(called(/^gh api -X PATCH repos\/acme\/widgets\/issues\/comments\/55501 -f body=a new address/)).toHaveLength(1);
    expect(called(/issues\/100\/comments/)).toHaveLength(0);
    expect(s.commentId).toBe(55501); // an edit answers with the same id, and an unreadable one changes nothing
  });

  it('is false when GitHub refuses, so no caller records a link it never handed out', async () => {
    onGh(/issues\/100\/comments/, fail('HTTP 410: Gone\nand the detail'));
    const s = state();
    expect(await post(42, s, 'the body')).toBe(false);
    expect(s.commentId).toBeUndefined();
    expect(readLog().join('\n')).toMatch(/preview #42: comment failed: HTTP 410: Gone/);
  });
});
