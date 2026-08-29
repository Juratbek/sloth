/** What the machine Sloth runs on reports about itself: how it is reachable, what it is running, and
 *  whether it starts itself at login. Split out of `types.ts`, which re-exports all of it. */

/** Remote access: where the UI is reachable from outside once the tunnel is up, or why it is not. */
export interface RemoteStatus {
  url?: string;
  error?: string;
}
export interface InstallStatus {
  running: boolean;
  /** The last lines brew printed. */
  output: string;
  error?: string;
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
