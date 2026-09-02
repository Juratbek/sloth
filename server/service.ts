import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeAtomic } from './atomic';
import { CONFIG_PATH, SLOTH_ROOT, cfg, envValue } from './config';
import { which } from './install';
import { run } from './runner/gh';
import { log } from './runner/log';
import type { ServiceStatus } from './types';

/**
 * Starting Sloth when the Mac starts. Watching stops when the process stops, so a Sloth that is only
 * ever started by hand misses the night it was meant to work through. macOS's own answer is a launch
 * agent: `launchd` starts it at login, restarts it when it dies, and `caffeinate -i` keeps the machine
 * from sleeping under it — the same command the README used to tell people to type themselves.
 *
 * Only macOS is supported. Elsewhere the toggle saves and says so: writing a systemd unit is a different
 * feature, not a translation of this one.
 */

export const supported = () => process.platform === 'darwin';

/** cron / launchd-style bare PATHs miss homebrew, and the agent needs `pnpm`, `git`, `gh` and `claude`. */
const PATH_EXTRA = ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local/bin')];
export const servicePath = () =>
  [...new Set([...(process.env.PATH ?? '').split(path.delimiter), ...PATH_EXTRA])].filter(Boolean).join(path.delimiter);

/** One agent per watched repository, so two Sloths on one Mac do not fight over the same label. */
export const label = () => `dev.sloth.${(cfg().repo.split('/')[1] || 'sloth').replace(/[^\w.-]/g, '-')}`;
export const plistPath = () => path.join(os.homedir(), 'Library/LaunchAgents', `${label()}.plist`);
const logFile = () => path.join(os.homedir(), '.sloth/service.log');
const target = () => `gui/${process.getuid?.() ?? 0}/${label()}`;

export interface PlistOptions {
  label: string;
  args: string[];
  workingDir: string;
  logFile: string;
  env: Record<string, string>;
}

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string);
const entry = (key: string, value: string) => `    <key>${esc(key)}</key>\n    <string>${esc(value)}</string>`;

/** The launch agent as launchd wants it. Pure, so a test can hold it against a fixture. */
export function plistFor(o: PlistOptions): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${entry('Label', o.label)}
    <key>ProgramArguments</key>
    <array>
${o.args.map((a) => `      <string>${esc(a)}</string>`).join('\n')}
    </array>
${entry('WorkingDirectory', o.workingDir)}
    <key>EnvironmentVariables</key>
    <dict>
${Object.entries(o.env)
  .map(([k, v]) => `      <key>${esc(k)}</key>\n      <string>${esc(v)}</string>`)
  .join('\n')}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
${entry('StandardOutPath', o.logFile)}
${entry('StandardErrorPath', o.logFile)}
</dict>
</plist>
`;
}

function plistNow(pnpm: string): string {
  const env: Record<string, string> = { PATH: servicePath(), HOME: os.homedir() };
  // Only what this Sloth was actually started with — an agent that guesses the config watches the wrong board.
  if (envValue('SLOTH_CONFIG')) env.SLOTH_CONFIG = CONFIG_PATH;
  if (envValue('SLOTH_PORT')) env.SLOTH_PORT = String(cfg().port);
  return plistFor({
    label: label(),
    // `pnpm start` is `vite preview`: it serves the built UI, so the checkout must carry a build.
    args: ['/usr/bin/caffeinate', '-i', pnpm, 'start'],
    workingDir: SLOTH_ROOT,
    logFile: logFile(),
    env,
  });
}

let error: string | undefined;

/** What the Settings page shows: whether the agent is registered here, and why the last change failed. */
export const serviceStatus = (): ServiceStatus => ({
  supported: supported(),
  installed: supported() && fs.existsSync(plistPath()),
  label: label(),
  plist: plistPath(),
  error,
});

async function install(): Promise<string | undefined> {
  if (!fs.existsSync(path.join(SLOTH_ROOT, 'dist/index.html'))) {
    return 'Sloth serves a built UI at login (`pnpm start` is `vite preview`) — run `pnpm build` first, then turn this on.';
  }
  const pnpm = which('pnpm');
  if (!pnpm) return '`pnpm` was not found on PATH, so launchd would have nothing to run.';
  const file = plistPath();
  fs.mkdirSync(path.dirname(logFile()), { recursive: true });
  // launchd reads this at every login; half a plist is an agent that never starts and says nothing.
  writeAtomic(file, plistNow(pnpm));
  const r = await run('launchctl', ['bootstrap', `gui/${process.getuid?.() ?? 0}`, file], { timeout: 30_000 });
  // A label already bootstrapped is the state we wanted; anything else leaves the plist for a look.
  if (!r.ok && !/already/i.test(r.err)) return `launchctl bootstrap failed: ${r.err.split('\n')[0]}`;
  // Never kickstart from here: this process *is* the running Sloth, and the agent would take its port.
  log(`autostart: ${label()} registered — it starts at next login (or \`launchctl kickstart -k ${target()}\` now)`);
  return undefined;
}

async function remove(): Promise<undefined> {
  const r = await run('launchctl', ['bootout', target()], { timeout: 30_000 });
  if (!r.ok && !/not find|no such process|not loaded/i.test(r.err)) log(`autostart: launchctl bootout said: ${r.err.split('\n')[0]}`);
  fs.rmSync(plistPath(), { force: true });
  log(`autostart: ${label()} removed — Sloth no longer starts at login`);
  return undefined;
}

/** Called when the saved `autostart` changed. Returns an error for the Settings page, or undefined. */
export async function applyAutostart(on: boolean): Promise<string | undefined> {
  if (!supported()) {
    log('autostart: only macOS is supported');
    error = undefined;
    return undefined;
  }
  error = on ? await install() : await remove();
  if (error) log(`autostart: ${error}`);
  return error;
}
