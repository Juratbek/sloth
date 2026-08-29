import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { which } from '../install';
import { log } from './log';

/**
 * The browser an implement session tests in: a headless Chrome of its own, driven through the Playwright
 * MCP server Sloth ships (`@playwright/mcp`), so the tester subagent gets the `browser_*` tools. Nothing is
 * shared between sessions — every run gets an isolated profile and its own screenshot directory.
 */

/**
 * The branch the tester's screenshots are pushed to, so a PR can embed them. It holds images only, under
 * `issue-<n>/<utc-timestamp>/`, is never merged and is never a code branch — the session skill's
 * `publish_shots` writes it, the reviewer reads it back.
 */
export const ASSETS_BRANCH = 'sloth-assets';

/** How the MCP server is told which browser to drive: an installed Chrome, or a Chromium binary by path. */
export type Browser = { channel: 'chrome' } | { executable: string };

const MAC_APP = 'Google Chrome.app/Contents/MacOS/Google Chrome';

/** Google Chrome on this machine, or Chromium as a stand-in; undefined when neither is installed. */
export function chromeBinary(): Browser | undefined {
  const apps = [path.join('/Applications', MAC_APP), path.join(os.homedir(), 'Applications', MAC_APP)];
  if (apps.some((app) => which(app)) || which('google-chrome') || which('google-chrome-stable')) return { channel: 'chrome' };
  const chromium = which('chromium') ?? which('chromium-browser');
  return chromium ? { executable: chromium } : undefined;
}

/** The MCP server's entry point inside Sloth's own install — the session's project has no say in it. */
function cliPath(): string {
  const pkg = createRequire(import.meta.url).resolve('@playwright/mcp/package.json');
  return path.join(path.dirname(pkg), 'cli.js');
}

let warned = false;

/**
 * Writes the `mcp.json` a session is started with and returns its path: one Playwright MCP server, headless,
 * on an isolated profile, screenshotting into `screenshotsDir` (also the server's own output directory).
 * Undefined when no browser is installed — the session then runs without one, and its PR gets no screenshots.
 */
export function mcpConfig(bookDir: string, screenshotsDir: string): string | undefined {
  const browser = chromeBinary();
  if (!browser) {
    if (!warned) log('chrome: Google Chrome not found on this machine — sessions run without a browser, PRs get no screenshots');
    warned = true;
    return undefined;
  }
  fs.mkdirSync(screenshotsDir, { recursive: true });
  fs.mkdirSync(bookDir, { recursive: true });
  const flag = 'channel' in browser ? ['--browser', browser.channel] : ['--executable-path', browser.executable];
  const file = path.join(bookDir, 'mcp.json');
  const config = {
    mcpServers: {
      playwright: {
        command: process.execPath,
        args: [cliPath(), '--headless', '--isolated', '--viewport-size', '1280x800', '--output-dir', screenshotsDir, ...flag],
      },
    },
  };
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
  return file;
}
