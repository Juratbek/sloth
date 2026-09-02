import { execFile } from 'node:child_process';
import { cfg } from './config';
import { STACK, type StackId } from './config-types';
import { stackOf } from './config-file';
import { installStatus, runJob, which, type Step } from './install';
import { isDry, log } from './runner/log';
import { startStackSession, withStackSession } from './stack-session';
import { TOOLS, detectStack, requiredStack } from './stack-detect';
import { canSudoApt, unlockSudo } from './sudo';
import type { StackStatus, StackTool } from './types';

export { detectStack, requiredStack } from './stack-detect';

/**
 * The stack: the tools a project's app may need on the machine Sloth runs on, and the only ones Sloth
 * installs — PostgreSQL, Redis, Node, Python, Java (`STACK` in `config-types.ts`). A session that
 * cannot boot the app cannot verify anything and leaves no preview, so the wizard installs what the
 * checkout needs before the first run, and every start installs whatever is still missing
 * (`ensureStack`). Homebrew on macOS (or Linuxbrew), `apt-get` with passwordless sudo on Debian /
 * Ubuntu / WSL — and where that sudo is refused, the Stack page asks for the user's password once and
 * writes the rule that grants it (`sudo.ts`); anything else reports what to install by hand.
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

/** `password` on the `none` case: nothing is missing but the user's sudo password (`sudo.ts` `unlockSudo`). */
type Installer = { kind: 'brew' } | { kind: 'apt'; sudo: boolean } | { kind: 'none'; error: string; password?: boolean };

const isRoot = () => typeof process.getuid === 'function' && process.getuid() === 0;

/** The package manager Sloth can drive here, or why there is none. */
export async function installer(): Promise<Installer> {
  if (which('brew')) return { kind: 'brew' };
  if (!which('apt-get')) return { kind: 'none', error: 'no Homebrew and no apt-get on this machine — install the tools by hand' };
  if (isRoot()) return { kind: 'apt', sudo: false };
  // `sudo -n -l <apt-get>` asks the one question that matters — may this user run apt-get without a
  // password — and answers it for a blanket NOPASSWD line as well as for Sloth's own scoped rule.
  if (await canSudoApt()) return { kind: 'apt', sudo: true };
  return {
    kind: 'none',
    password: true,
    error: 'apt-get needs passwordless sudo here — give Sloth your password once and it sets that up, or allow it in sudoers by hand',
  };
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
    ...(by.kind === 'none' && by.password ? { sudoPassword: true } : {}),
    install: withStackSession(installStatus()),
  };
}

/**
 * Installs the given tools, skipping what is already there. `session` picks who does it: an AI session
 * the page can watch, or `runJob`'s fixed list of commands. Left out it means apt — where the install
 * is a package, a service and a database role, and a session sees what went wrong; `ensureStack` at
 * boot passes `false`, because there is no page open to watch a session there. Returns what it set out
 * to install, or the reason nothing started.
 */
export async function installStack(ids: StackId[], options: { session?: boolean } = {}): Promise<{ started: StackId[]; error?: string }> {
  const missing = await absent(ids);
  if (!missing.length) return { started: [] };
  const by = await installer();
  if (by.kind === 'none') return { started: [], error: `${by.error} (${missing.map(manualCommand).join('; ')})` };
  if (options.session ?? by.kind === 'apt') return startStackSession(missing);
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
  const r = await installStack(missing, { session: false });
  if (r.error) log(`stack: ${names} missing — ${r.error}`);
  else if (r.started.length) log(`stack: ${names} missing — installing`);
}

/** The `ids` of a request body, or whatever the configured stack is still missing when it names none. */
async function wanted(body: unknown): Promise<StackId[]> {
  const ids = stackOf((body as { ids?: unknown } | undefined)?.ids);
  return ids === 'auto' || !ids.length ? await absent(requiredStack()) : ids;
}

/**
 * Takes the password, spends it on the sudoers rule (`sudo.ts` — it never comes back out of that call,
 * is never logged and never reaches the session) and installs what is missing through an AI session.
 */
async function unlock(body: unknown): Promise<string | undefined> {
  const password = (body as { password?: unknown } | undefined)?.password;
  if (typeof password !== 'string' || !password.trim()) return 'a password is needed';
  try {
    const error = await unlockSudo(password);
    if (error) return error;
    return (await installStack(await wanted(body), { session: true })).error;
  } catch (e) {
    // Whatever went wrong is a file or a process error, never the body: this is the one request whose
    // failure must not be echoed back unread.
    return e instanceof Error ? e.message : 'the sudoers rule could not be written';
  }
}

/**
 * `/api/stack` (the state), `POST /api/stack/install` (`{ids, ai}`) and `POST /api/stack/unlock`
 * (`{password, ids}`): one answer shape, the state — plus why an install just asked for did not start.
 * `root` asks about a checkout other than the configured one. Nothing here ever puts the body in the
 * answer or in the log.
 */
export async function handleStack(pathname: string, method: string, root: string | undefined, body: unknown): Promise<StackStatus> {
  let installError: string | undefined;
  if (method === 'POST' && pathname === '/api/stack/install') {
    const ai = (body as { ai?: unknown } | undefined)?.ai === true;
    // `auto` (or no ids at all) means what it means on the unlock path: whatever the configured stack
    // still lacks. Mapped to `[]` it installed nothing and reported no error — a silent no-op.
    installError = (await installStack(await wanted(body), ai ? { session: true } : {})).error;
  } else if (method === 'POST' && pathname === '/api/stack/unlock') {
    installError = await unlock(body);
  }
  return { ...(await stackStatus(root)), ...(installError ? { installError } : {}) };
}
