import type { StackId } from './config-types';

/** What the machine Sloth runs on reports about itself: how it is reachable, what it is running, and
 *  whether it starts itself at login. Split out of `types.ts`, which re-exports all of it. */

/** Remote access: where the UI is reachable from outside once the tunnel is up, or why it is not. */
export interface RemoteStatus {
  url?: string;
  error?: string;
}
export interface InstallStatus {
  running: boolean;
  /** What is being installed right now — `PostgreSQL`, `cloudflared` … */
  what?: string;
  /** The last lines the package manager printed. */
  output: string;
  error?: string;
  /** The transcript of the AI session doing the installing, when a session is doing it (`stack-session.ts`). */
  sessionId?: string;
}

/** One tool of the stack (`config-types.ts` `STACK`) as this machine has it. */
export interface StackTool {
  id: StackId;
  label: string;
  /** The executable the check looks for — `psql`, `redis-server`, `node` … */
  command: string;
  installed: boolean;
  version?: string;
  /** The checkout at the root asked about looks like it needs this. */
  detected: boolean;
}
/** The stack: every tool Sloth can install, what the checkout needs, and whether this machine can install anything. */
export interface StackStatus {
  tools: StackTool[];
  /** The package manager the install goes through; absent when there is none Sloth can drive. */
  installer?: 'brew' | 'apt';
  /** Why nothing can be installed from here — no Homebrew, no passwordless sudo for apt … */
  installerError?: string;
  /** apt is here, Sloth is not root and `sudo -n` is refused: the user's password would unlock installing (`POST /api/stack/unlock`). */
  sudoPassword?: boolean;
  install: InstallStatus;
  /** Why the install just asked for did not start. */
  installError?: string;
}
/**
 * The repository webhook Sloth configures for itself (`server/webhook.ts`), so an `@sloth` comment is
 * read the moment it is written instead of at the next poll. `off` is nothing configured — no public
 * address, or a tunnel that is down; `failed` names what GitHub or `gh` said.
 */
export interface WebhookStatus {
  state: 'off' | 'active' | 'failed';
  /** The address the provider was given — `<public URL>/api/hooks/github`, or `/api/hooks/trello` on a Trello board. */
  url?: string;
  /** GitHub numbers its hooks; Trello names them. */
  hookId?: number | string;
  /** Why it is not delivering; absent while it is. */
  reason?: string;
  /** When the state above was last decided. */
  at?: number;
  /** The last `ping` GitHub sent, and the last mention that started a comments tick. */
  lastPing?: number;
  lastDelivery?: number;
}

/** The status as the settings page reads it: whether it is really live, and which poll that puts in force. */
export interface WebhookInfo extends WebhookStatus {
  /** Configured *and* pointing at the address Sloth is reachable at right now. */
  live: boolean;
  commentSeconds: number;
  fallbackCommentSeconds: number;
  /** The interval the comments timer is actually running at — the fallback whenever the webhook is not live. */
  effectiveCommentSeconds: number;
}

/** The QR code's payload — the address with the secret that signs a phone in — and what stands in its way. */
export interface RemoteLink extends RemoteStatus {
  link?: string;
  /** The tunnel tool; absent when `publicUrl` is set and no tool is needed. */
  tool?: { command: string; installed: boolean; installable: boolean };
  install: InstallStatus;
}

/** The update the settings page started: which step it is on, the last lines it printed, how it ended. */
export interface UpdateStatus {
  running: boolean;
  step?: 'pull' | 'install' | 'build' | 'restart';
  output: string;
  error?: string;
  /** The new process is starting; the page reloads once it answers. */
  restarting: boolean;
}
/** What Sloth this is: its version, the commit of the checkout, and how far behind the remote it is. */
export interface VersionInfo {
  /** `major.minor` from package.json and, for the patch, the number of PRs merged into the branch (`update.ts` `versionOf`). */
  version: string;
  commit?: string;
  date?: string;
  branch?: string;
  /** Tracked files changed in the checkout — a pull may refuse. */
  dirty: boolean;
  /** Commits on origin/<branch> this checkout lacks; unknown until a check ran. */
  behind?: number;
  checkedAt?: string;
  checkError?: string;
  update: UpdateStatus;
}

/** The launch agent that starts Sloth at login — Settings → Machine shows this. */
export interface ServiceStatus {
  /** Only macOS has an implementation; elsewhere the toggle saves and does nothing. */
  supported: boolean;
  installed: boolean;
  label: string;
  plist: string;
  /** Why the last change failed — a missing build, mostly. */
  error?: string;
}

/** One thing the runner needs in order to do any work at all — see `server/health.ts`. */
export type HealthId = 'gh' | 'git' | 'chrome' | 'sudo' | 'trello';
export interface HealthCheck {
  id: HealthId;
  ok: boolean;
  /** One line: what was found, or what the command said when it failed. */
  detail: string;
  /** Nothing to check here — the browser is off, the stack needs no sudo — so `ok` says nothing. */
  skipped?: boolean;
}
/**
 * Whether this machine can actually do the work: `gh` signed in, the runner checkout's `origin`
 * reachable, a browser for the screenshots, and passwordless sudo where installing the stack needs it.
 * `at` is when the checks were taken — they are cached and re-run at most every ten minutes.
 */
export interface Health {
  at: number;
  checks: HealthCheck[];
}
