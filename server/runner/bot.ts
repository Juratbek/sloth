import { cfg } from '../config';
import { gh } from './gh';
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

let login: string | undefined;

/** The login Sloth's comments are written under, once it is known. */
export const botLogin = (): string | undefined => login;

/** Reads the login `gh` acts as; called when the server mounts. A failed read is said once and left unknown. */
export async function refreshBotLogin(): Promise<void> {
  const r = await gh(['api', 'user', '--jq', '.login']);
  if (!r.ok) {
    log(`the GitHub login Sloth comments as could not be read (${r.err.split('\n')[0]}) — its own comments are told apart by their prefix alone`);
    return;
  }
  login = r.out.trim() || undefined;
  if (login) log(`Sloth comments on GitHub as ${login}`);
}

/** Tests start each case from a known login, or from none. */
export const setBotLogin = (value: string | undefined): void => {
  login = value;
};

/** Whether Sloth wrote this comment: its prefix, and — once the login is known — its author too. */
export const wroteIt = (author: string, body: string): boolean =>
  body.startsWith(cfg().botPrefix) && (!login || author.toLowerCase() === login.toLowerCase());
