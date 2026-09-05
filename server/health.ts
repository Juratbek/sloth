import { cfg } from './config';
import { checkoutState } from './checkout';
import { ownerConflict } from './runner/owner';
import { me as trelloMe, trelloReady } from './trello';
import { chromeBinary, type Browser } from './runner/browser';
import { run } from './runner/gh';
import { log } from './runner/log';
import { installer, type Installer } from './stack';
import type { Health, HealthCheck } from './machine-types';

/**
 * Can this machine do the work at all?
 *
 * Everything Sloth does rests on four things that are either there or not: `gh` signed in (every board
 * read, comment and PR goes through it), the runner checkout's `origin` reachable (every session starts
 * with a fetch), a browser when the sessions are asked to test in one, and passwordless sudo where
 * installing the stack needs it. When one of them is missing Sloth does not stop — it fails a card at a
 * time, in the log, an hour after the token expired. This is the one place that asks the four questions
 * up front, so the header can say "gh failing" instead of the user reading `watcher.log` to find out.
 *
 * Every check is read-only, so a dry run takes them exactly as a real one does, and every one of them
 * shells out with a timeout of its own: the answer is worth a few seconds and nothing more — a `gh` that
 * hangs on a dead network must not take the tick with it.
 *
 * The result is cached. It is taken once when the API mounts and then at most every `HEALTH_INTERVAL_MS`
 * from the board tick (`runner/loop.ts`), which is why `healthTick` and not `refreshHealth` is what the
 * loop calls: a board read every five minutes must not become a `gh auth status` every five minutes.
 * The header's button is the way to ask for a fresh answer now.
 */

/** Long enough for a slow network, short enough that four of them cannot stall a tick. */
const TIMEOUT = 15_000;
/** The floor between two automatic runs; the tick asks more often than this and is told no. */
export const HEALTH_INTERVAL_MS = 10 * 60_000;

/** The first line with anything on it — what a tool said, without its stack of hints. */
const first = (...texts: string[]): string => {
  for (const text of texts)
    for (const line of text.split('\n')) if (line.trim()) return line.trim();
  return '';
};

/**
 * `gh auth status`, which writes to either stream depending on the version, and whose first line is the
 * host rather than the answer — the account is on the indented line under it, so that one is preferred.
 */
async function ghCheck(): Promise<HealthCheck> {
  const r = await run('gh', ['auth', 'status'], { timeout: TIMEOUT });
  const said = `${r.out}\n${r.err}`;
  const account = said.split('\n').map((l) => l.trim()).find((l) => /logged in/i.test(l));
  return {
    id: 'gh',
    ok: r.ok,
    detail: (r.ok ? account : undefined) ?? first(r.ok ? r.out : r.err, r.ok ? r.err : r.out) ?? '',
  };
}

/**
 * The one question that covers the network, the remote and the credentials at once: can this checkout
 * reach the repository it works on? `--exit-code` makes an empty answer a failure rather than a silent
 * success, so a `origin` pointing at nothing is caught here and not by a session an hour later.
 */
async function gitCheck(): Promise<HealthCheck> {
  const cwd = cfg().runnerRoot;
  // No checkout yet is not a fault while Sloth is making one (`checkout.ts`); it is one when it could not.
  const state = checkoutState(cwd);
  if (state.kind === 'cloning') return { id: 'git', ok: true, detail: `cloning ${state.repo} into ${cwd}` };
  if (state.kind === 'error') return { id: 'git', ok: false, detail: state.error };
  if (state.kind === 'missing') return { id: 'git', ok: false, detail: `no checkout at ${cwd} yet — Sloth clones ${cfg().repo} there on the next tick` };
  const r = await run('git', ['ls-remote', '--exit-code', 'origin', 'HEAD'], { timeout: TIMEOUT, cwd });
  return {
    id: 'git',
    ok: r.ok,
    detail: r.ok ? `origin is reachable from ${cwd}` : first(r.err, r.out) || `git ls-remote origin failed in ${cwd}`,
  };
}

/**
 * A browser for the screenshots — only asked when `chrome` is on, because with it off the sessions are
 * meant to run without one and a missing Chrome is not a fault. Takes the finder as an argument so a
 * test can say what this machine has instead of depending on what it happens to have.
 */
export function chromeCheck(on: boolean, browser: Browser | undefined): HealthCheck {
  if (!on) return { id: 'chrome', ok: true, skipped: true, detail: 'browser testing is off — sessions are not asked for screenshots' };
  if (!browser) return { id: 'chrome', ok: false, detail: 'no Google Chrome or Chromium on this machine — sessions run without a browser and their PRs get no screenshots' };
  return { id: 'chrome', ok: true, detail: 'channel' in browser ? 'Google Chrome' : browser.executable };
}

/**
 * Whether installing the stack can still get at a package manager. `installer()` (`stack.ts`) already
 * asks exactly this — `sudo -n -l apt-get`, which answers for a blanket NOPASSWD line as well as for
 * Sloth's own `/etc/sudoers.d/sloth` — so the rule's "is it installed" check lives there and this only
 * reads the answer. Nothing to say where the question does not arise: Homebrew needs no sudo, and a
 * machine with neither brew nor apt-get has no rule to be missing.
 */
export function sudoCheck(by: Installer): HealthCheck {
  if (by.kind === 'brew') return { id: 'sudo', ok: true, skipped: true, detail: 'Homebrew installs the stack here — no sudoers rule is needed' };
  if (by.kind === 'apt' && by.wide) {
    return { id: 'sudo', ok: false, detail: 'sudo lets this user run apt-get with any arguments — wider than the exact lines Sloth grants (an older Sloth\'s rule, or one of the machine\'s own); Settings → Stack replaces Sloth\'s file with the password' };
  }
  if (by.kind === 'apt') return { id: 'sudo', ok: true, detail: by.sudo ? 'apt-get runs without a password' : 'Sloth runs as root — apt-get needs no sudo' };
  if (!by.password) return { id: 'sudo', ok: true, skipped: true, detail: by.error };
  return { id: 'sudo', ok: false, detail: by.error };
}

/** On a Trello board: whether the key and token still open the account the board is on. Not a check at all elsewhere. */
async function trelloCheck(): Promise<HealthCheck | undefined> {
  if (cfg().project.provider !== 'trello') return undefined;
  if (!trelloReady()) return { id: 'trello', ok: false, detail: 'no Trello key and token — set them in Settings → Board; the board cannot be read without them' };
  try {
    return { id: 'trello', ok: true, detail: `signed in as ${(await trelloMe()).username}` };
  } catch (e) {
    return { id: 'trello', ok: false, detail: first(e instanceof Error ? e.message : String(e)) || 'Trello did not answer' };
  }
}

/** Whether this instance is watching at all, or held off its state directory by another Sloth (`runner/owner.ts`). */
const ownerCheck = (): HealthCheck => {
  const conflict = ownerConflict();
  return conflict ? { id: 'state', ok: false, detail: conflict } : { id: 'state', ok: true, detail: `this Sloth alone works in ${cfg().stateDir}` };
};

/** One reading of all of them, taken together — the shell-outs go at once, so the whole thing is one timeout long. */
export async function checkHealth(): Promise<Health> {
  const [gh, git, by, trello] = await Promise.all([ghCheck(), gitCheck(), installer(), trelloCheck()]);
  return { at: Date.now(), checks: [gh, git, chromeCheck(cfg().chrome, chromeBinary()), sudoCheck(by), ...(trello ? [trello] : []), ownerCheck()] };
}

let cache: Health | undefined;
let inFlight: Promise<Health> | undefined;
let announced: string | undefined;

/** The last reading; nothing until the first one has come back. */
export const healthStatus = (): Health | undefined => cache;

/** What the log says about a reading — only when it says something new, so a healthy machine is quiet. */
function announce(health: Health): void {
  const bad = health.checks.filter((c) => !c.ok && !c.skipped);
  const line = bad.length ? `health: ${bad.map((c) => `${c.id} — ${c.detail}`).join('; ')}` : 'health: every check is in order';
  if (line === announced) return;
  announced = line;
  log(line);
}

/**
 * Takes a reading now and caches it. Two callers at once share one run: the mount's fire-and-forget and
 * a header button pressed while it is still going would otherwise both spend a `gh auth status`.
 */
export function refreshHealth(): Promise<Health> {
  if (inFlight) return inFlight;
  const running = checkHealth().then((health) => {
    cache = health;
    announce(health);
    return health;
  });
  inFlight = running.finally(() => {
    inFlight = undefined;
  });
  return inFlight;
}

/**
 * The board tick's step. The tick runs every `boardSeconds` — five minutes by default, and a "Tick now"
 * whenever someone presses it — so the interval is enforced here rather than by how often it is called.
 */
export async function healthTick(now = Date.now()): Promise<void> {
  if (cache && now - cache.at < HEALTH_INTERVAL_MS) return;
  await refreshHealth();
}

/** The first reading, when the API mounts: nothing waits for it, and the log gets the result either way. */
export function startHealth(): void {
  void refreshHealth().catch((e) => log(`health check failed: ${(e instanceof Error ? e.message : String(e)).split('\n')[0]}`));
}

/** Tests only: back to "never checked". */
export function forgetHealth(): void {
  cache = undefined;
  inFlight = undefined;
  announced = undefined;
}
