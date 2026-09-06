import { cfg } from '../config';
import { run } from './gh';
import { log } from './log';

/**
 * Who Sloth is on GitHub. Every comment Sloth writes opens with `botPrefix`, and three readers take that
 * prefix as "these are Sloth's own words": `answers.ts` skips them to find where the question was asked,
 * trigger 3 skips them so Sloth never answers itself, and the Trello mirror copies them onto the card
 * unattributed. The prefix is anyone's to type. A `**Sloth:** ok` from any account that may comment on a
 * parked card reset the answer scan, so the real answer under it counted for nothing and the card waited
 * for ever — and read on the Trello card as Sloth's own words.
 *
 * The login `gh` acts as is read once at boot and asked for beside the prefix: both, or the comment is
 * somebody else's. Until that read succeeds the prefix is all there is, which is where this started —
 * treating Sloth's own comments as a stranger's would be the worse failure, since the run would then
 * answer itself in a loop.
 */

/** As long as the other health checks are given: a login nobody answers for is not worth a tick. */
const LOGIN_TIMEOUT = 15_000;

let login: string | undefined;
let said = false;

/** The login Sloth's comments are written under, once it is known. */
export const botLogin = (): string | undefined => login;

/**
 * Reads the login `gh` acts as. Called when the server mounts and again on every tick until it answers:
 * a Sloth that mounts before anybody has logged `gh` in — a fresh install, where the wizard's *Log in*
 * button comes minutes later — would otherwise spend the rest of the process on the prefix alone, with
 * every reader below still open to a comment somebody else wrote. Once read it is never read again, and
 * the failure is logged once so a tick every few minutes does not fill `watcher.log`.
 */
export async function refreshBotLogin(): Promise<void> {
  if (login) return;
  // `run`, not `gh`: the health reading this rides on is awaited inside the board tick, and `gh` waits a
  // minute and then retries — two minutes of a dead network would hold the whole tick before the board is
  // even read. The next reading asks again, which is a better retry than one nothing can interrupt.
  const r = await run('gh', ['api', 'user', '--jq', '.login'], { timeout: LOGIN_TIMEOUT });
  if (!r.ok) {
    if (!said) log(`the GitHub login Sloth comments as could not be read (${r.err.split('\n')[0]}) — its own comments are told apart by their prefix alone until it can be`);
    said = true;
    return;
  }
  login = r.out.trim() || undefined;
  if (login) log(`Sloth comments on GitHub as ${login}`);
}

/** Tests start each case from a known login, or from none. */
export const setBotLogin = (value: string | undefined): void => {
  login = value;
  said = false;
};

/** Whether Sloth wrote this comment: its prefix, and — once the login is known — its author too. */
export const wroteIt = (author: string, body: string): boolean =>
  body.startsWith(cfg().botPrefix) && (!login || author.toLowerCase() === login.toLowerCase());
