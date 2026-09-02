/**
 * What to show the user when something the UI asked for failed.
 *
 * `String(err)` on an `Error` renders "Error: the tunnel is not up", and the prefix is noise on a page
 * where everything red is already an error. `postJson` throws the server's own `{ error }` message, so
 * the message alone is the whole sentence. Anything that is not an `Error` — a string thrown somewhere,
 * a rejected value — is still shown rather than swallowed, because a silent failure looks like a no-op.
 */
export function errorText(err: unknown): string {
  if (err === null || err === undefined) return '';
  if (err instanceof Error) return err.message || String(err);
  if (typeof err === 'string') return err;
  if (typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return String(err);
}
