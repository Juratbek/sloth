import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ASSETS_BRANCH, chromeBinary, mcpConfig } from '../server/runner/browser';
import { configure, root } from './harness';

// Chrome detection goes through `which`, so a test decides what this machine has — the real one always
// has Google Chrome, and the "nothing installed" case must be reproducible anywhere.
let installed: string[] = [];
vi.mock('../server/install', () => ({
  EXTRA_DIRS: [],
  which: (cmd: string) => (installed.some((c) => cmd === c || cmd.includes(c)) ? cmd : undefined),
}));

const dirs = () => ({ book: path.join(root(), 'book'), shots: path.join(root(), 'book', 'screenshots') });
const args = (file: string): string[] =>
  (JSON.parse(fs.readFileSync(file, 'utf8')) as { mcpServers: { playwright: { args: string[] } } }).mcpServers.playwright.args;

beforeEach(() => {
  configure();
  fs.rmSync(path.join(root(), 'book'), { recursive: true, force: true });
  installed = ['Google Chrome.app'];
});

describe('chromeBinary', () => {
  it('is the chrome channel for an installed Google Chrome, and the path of a Chromium', () => {
    expect(chromeBinary()).toEqual({ channel: 'chrome' });
    installed = ['google-chrome-stable'];
    expect(chromeBinary()).toEqual({ channel: 'chrome' });
    installed = ['chromium-browser'];
    expect(chromeBinary()).toEqual({ executable: 'chromium-browser' });
  });
  it('is undefined when no browser is installed', () => {
    installed = [];
    expect(chromeBinary()).toBeUndefined();
  });
});

describe('mcpConfig', () => {
  it('writes the Playwright MCP server into the book directory and makes the screenshots directory', () => {
    const { book, shots } = dirs();
    const file = mcpConfig(book, shots)!;
    expect(file).toBe(path.join(book, 'mcp.json'));
    expect(fs.existsSync(shots)).toBe(true);
    const a = args(file);
    expect(a[0]).toMatch(/@playwright[/\\]mcp[/\\]cli\.js$/);
    expect(a).toContain('--headless');
    expect(a).toContain('--isolated');
    expect(a.slice(a.indexOf('--output-dir'), a.indexOf('--output-dir') + 2)).toEqual(['--output-dir', shots]);
    expect(a.slice(-2)).toEqual(['--browser', 'chrome']);
  });
  it('points the server at a Chromium binary when that is what the machine has', () => {
    installed = ['chromium'];
    const { book, shots } = dirs();
    expect(args(mcpConfig(book, shots)!).slice(-2)).toEqual(['--executable-path', 'chromium']);
  });
  it('is undefined with no browser on the machine — the session runs without one', () => {
    installed = [];
    const { book, shots } = dirs();
    expect(mcpConfig(book, shots)).toBeUndefined();
    expect(fs.existsSync(path.join(book, 'mcp.json'))).toBe(false);
  });
});

describe('ASSETS_BRANCH', () => {
  it('names the branch screenshots are pushed to', () => {
    expect(ASSETS_BRANCH).toBe('sloth-assets');
  });
});
