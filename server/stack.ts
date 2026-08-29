import { execFile } from 'node:child_process';
import { cfg } from './config';
import { STACK, type StackId } from './config-types';
import { stackOf } from './config-file';
import { installStatus, runJob, which, type Step } from './install';
import { isDry, log } from './runner/log';
import { TOOLS, detectStack, requiredStack } from './stack-detect';
import type { StackStatus, StackTool } from './types';

export { detectStack, requiredStack } from './stack-detect';

/**
 * The stack: the tools a project's app may need on the machine Sloth runs on, and the only ones Sloth
 * installs — PostgreSQL, Redis, Node, Python, Java (`STACK` in `config-types.ts`). A session that
 * cannot boot the app cannot verify anything and leaves no preview, so the wizard installs what the
 * checkout needs before the first run, and every start installs whatever is still missing
 * (`ensureStack`). Homebrew on macOS (or Linuxbrew), `apt-get` with passwordless sudo on Debian /
 * Ubuntu / WSL; anything else reports what to install by hand.
 */

function run(cmd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) =>
    execFile(cmd, args, { timeout: 20_000 }, (error, stdout, stderr) =>
      resolve({ ok: !error, out: `${String(stdout ?? '')}\n${String(stderr ?? '')}`.trim().split('\n')[0].trim() }),
    ),
  );
}

/** Installed means the executable is there *and* answers — macOS ships a `java` stub that only says there is no Java. */
async function check(id: StackId, detected: StackId[]): Promise<StackTool> {
  const t = TOOLS[id];
  const bin = which(t.command);
  const r = bin ? await run(bin, t.version) : { ok: false, out: '' };
  return { id, label: t.label, command: t.command, installed: r.ok, ...(r.ok && r.out ? { version: r.out } : {}), detected: detected.includes(id) };
}

/** Of `ids`, the tools this machine does not have. */
const absent = async (ids: StackId[]): Promise<StackId[]> =>
  (await Promise.all(ids.map((id) => check(id, [])))).filter((t) => !t.installed).map((t) => t.id);

type Installer = { kind: 'brew' } | { kind: 'apt'; sudo: boolean } | { kind: 'none'; error: string };

const isRoot = () => typeof process.getuid === 'function' && process.getuid() === 0;

/** The package manager Sloth can drive here, or why there is none. */
export async function installer(): Promise<Installer> {
  if (which('brew')) return { kind: 'brew' };
  if (!which('apt-get')) return { kind: 'none', error: 'no Homebrew and no apt-get on this machine — install the tools by hand' };
  if (isRoot()) return { kind: 'apt', sudo: false };
  const r = await run('sudo', ['-n', 'true']);
  if (r.ok) return { kind: 'apt', sudo: true };
  return { kind: 'none', error: 'apt-get needs passwordless sudo here — run the apt-get install by hand, or allow it in sudoers' };
}

/** The commands that install one tool and leave its service running, for the given package manager. */
export function installSteps(id: StackId, by: Installer): Step[] {
  const t = TOOLS[id];
  if (by.kind === 'brew') {
    const steps: Step[] = [{ cmd: 'brew', args: ['install', t.brew.formula] }];
    if (t.brew.link) steps.push({ cmd: 'brew', args: ['link', '--force', '--overwrite', t.brew.formula], optional: true });
    if (t.brew.service) steps.push({ cmd: 'brew', args: ['services', 'start', t.brew.service] });
    return steps;
  }
  if (by.kind === 'apt') {
    const sudo = (args: string[]): Step => (by.sudo ? { cmd: 'sudo', args: ['-n', ...args] } : { cmd: args[0], args: args.slice(1) });
    const steps: Step[] = [sudo(['apt-get', 'update', '-q']), sudo(['apt-get', 'install', '-y', '-q', ...t.apt.packages])];
    if (t.apt.service) steps.push({ ...sudo(['service', t.apt.service, 'start']), optional: true });
    // The sessions create databases as the user Sloth runs as; apt's PostgreSQL only knows `postgres`.
    if (id === 'postgresql' && !isRoot()) steps.push({ ...sudo(['-u', 'postgres', 'createuser', '-s', process.env.USER ?? 'sloth']), optional: true });
    return steps;
  }
  return [];
}

/** The by-hand command for a tool the machine cannot install itself. */
export function manualCommand(id: StackId): string {
  const t = TOOLS[id];
  return process.platform === 'darwin' ? `brew install ${t.brew.formula}` : `sudo apt-get install -y ${t.apt.packages.join(' ')}`;
}

/** Every tool's state: installed or not, wanted by the checkout at `root` (the configured one by default) or not. */
export async function stackStatus(root = cfg().runnerRoot): Promise<StackStatus> {
  const detected = detectStack(root);
  const [tools, by] = await Promise.all([Promise.all(STACK.map((id) => check(id, detected))), installer()]);
  return {
    tools,
    installer: by.kind === 'none' ? undefined : by.kind,
    installerError: by.kind === 'none' ? by.error : undefined,
    install: installStatus(),
  };
}

/**
 * Installs the given tools, one after the other, skipping what is already there. Returns what it set out
 * to install, or the reason nothing started.
 */
export async function installStack(ids: StackId[]): Promise<{ started: StackId[]; error?: string }> {
  const missing = await absent(ids);
  if (!missing.length) return { started: [] };
  const by = await installer();
  if (by.kind === 'none') return { started: [], error: `${by.error} (${missing.map(manualCommand).join('; ')})` };
  if (isDry()) {
    log(`dry-run: would install ${missing.map((id) => TOOLS[id].label).join(', ')} with ${by.kind}`);
    return { started: missing };
  }
  const label = missing.map((id) => TOOLS[id].label).join(', ');
  const ok = runJob({ label, steps: missing.flatMap((id) => installSteps(id, by)) }, () => log(`stack: ${label} installed`));
  return ok ? { started: missing } : { started: [], error: 'an install is already running' };
}

/** At start-up: whatever the configured stack still lacks gets installed, so the next session can boot the app. */
export async function ensureStack(): Promise<void> {
  if (!cfg().configured) return;
  const required = requiredStack();
  const missing = await absent(required);
  if (!missing.length) {
    if (required.length) log(`stack: ${required.map((id) => TOOLS[id].label).join(', ')} present`);
    return;
  }
  const names = missing.map((id) => TOOLS[id].label).join(', ');
  const r = await installStack(missing);
  if (r.error) log(`stack: ${names} missing — ${r.error}`);
  else if (r.started.length) log(`stack: ${names} missing — installing`);
}

/**
 * `/api/stack` (the state) and `POST /api/stack/install` (`{ids}`): one answer shape, the state — plus
 * why an install just asked for did not start. `root` asks about a checkout other than the configured one.
 */
export async function handleStack(pathname: string, method: string, root: string | undefined, body: unknown): Promise<StackStatus> {
  let installError: string | undefined;
  if (pathname === '/api/stack/install' && method === 'POST') {
    const ids = stackOf((body as { ids?: unknown } | undefined)?.ids);
    installError = (await installStack(ids === 'auto' ? [] : ids)).error;
  }
  return { ...(await stackStatus(root)), ...(installError ? { installError } : {}) };
}
