import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SLOTH_ROOT } from '../server/config';
import { applyAutostart, label, plistFor, plistPath, serviceStatus, supported } from '../server/service';
import { called, resetGh } from './gh-mock';
import { configure, readLog, root, wipe } from './harness';

vi.mock('../server/runner/gh', () => import('./gh-mock'));

const FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>dev.sloth.widgets</string>
    <key>ProgramArguments</key>
    <array>
      <string>/usr/bin/caffeinate</string>
      <string>-i</string>
      <string>/opt/homebrew/bin/pnpm</string>
      <string>start</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/Users/x/sloth</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      <string>/usr/bin:/opt/homebrew/bin</string>
      <key>SLOTH_CONFIG</key>
      <string>/Users/x/.sloth/config.json</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/x/.sloth/service.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/x/.sloth/service.log</string>
</dict>
</plist>
`;

/** The build `pnpm start` serves; `applyAutostart` refuses to register an agent without it. */
const dist = path.join(SLOTH_ROOT, 'dist/index.html');

beforeEach(() => {
  configure();
  wipe();
  resetGh();
  fs.rmSync(plistPath(), { force: true });
});

describe('plistFor', () => {
  it('writes the launch agent launchd expects, escaping what goes into it', () => {
    expect(
      plistFor({
        label: 'dev.sloth.widgets',
        args: ['/usr/bin/caffeinate', '-i', '/opt/homebrew/bin/pnpm', 'start'],
        workingDir: '/Users/x/sloth',
        logFile: '/Users/x/.sloth/service.log',
        env: { PATH: '/usr/bin:/opt/homebrew/bin', SLOTH_CONFIG: '/Users/x/.sloth/config.json' },
      }),
    ).toBe(FIXTURE);
    expect(plistFor({ label: 'a&b', args: [], workingDir: '<x>', logFile: '/l', env: {} })).toContain('<string>a&amp;b</string>');
  });
});

describe('applyAutostart', () => {
  it('names the agent after the repository and reports where it would live', () => {
    expect(label()).toBe('dev.sloth.widgets');
    expect(plistPath()).toBe(path.join(os.homedir(), 'Library/LaunchAgents/dev.sloth.widgets.plist'));
    expect(serviceStatus()).toMatchObject({ supported: supported(), installed: false, label: 'dev.sloth.widgets' });
  });

  it.runIf(supported())('registers the agent with launchctl, without starting it', async () => {
    fs.mkdirSync(path.dirname(dist), { recursive: true });
    if (!fs.existsSync(dist)) fs.writeFileSync(dist, '<html></html>');
    expect(await applyAutostart(true)).toBeUndefined();
    expect(called(/^launchctl bootstrap gui\/\d+ .*dev\.sloth\.widgets\.plist$/)).toHaveLength(1);
    expect(called(/kickstart/)).toHaveLength(0);
    expect(fs.readFileSync(plistPath(), 'utf8')).toContain('<string>/usr/bin/caffeinate</string>');
    expect(serviceStatus().installed).toBe(true);
    expect(readLog().join('\n')).toMatch(/autostart: dev\.sloth\.widgets registered/);
  });

  it.runIf(supported())('boots the agent out and deletes the plist when it is turned off', async () => {
    fs.mkdirSync(path.dirname(plistPath()), { recursive: true });
    fs.writeFileSync(plistPath(), 'x');
    expect(await applyAutostart(false)).toBeUndefined();
    expect(called(/^launchctl bootout gui\/\d+\/dev\.sloth\.widgets$/)).toHaveLength(1);
    expect(fs.existsSync(plistPath())).toBe(false);
  });

  it.runIf(supported())('refuses to register an agent that would have nothing built to serve', async () => {
    const saved = fs.existsSync(dist) ? fs.readFileSync(dist) : undefined;
    fs.rmSync(dist, { force: true });
    try {
      expect(await applyAutostart(true)).toMatch(/pnpm build/);
      expect(called(/launchctl/)).toHaveLength(0);
      expect(fs.existsSync(plistPath())).toBe(false);
      expect(serviceStatus().error).toMatch(/pnpm build/);
    } finally {
      if (saved) fs.writeFileSync(dist, saved);
    }
  });

  it.skipIf(supported())('says so on a platform with no implementation', async () => {
    expect(await applyAutostart(true)).toBeUndefined();
    expect(called(/launchctl/)).toHaveLength(0);
    expect(readLog().at(-1)).toMatch(/autostart: only macOS is supported/);
  });
});

describe('the test home', () => {
  it('keeps the agent out of the real LaunchAgents directory', () => {
    expect(plistPath().startsWith(root())).toBe(true);
  });
});
