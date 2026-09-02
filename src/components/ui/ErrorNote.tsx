import { errorText } from '../../lib/errors';

/**
 * What a mutation said when it failed, beside the control that ran it.
 *
 * Pause, Tick, Stop, stop preview, New link and Install each threw into `mutation.error` and nothing
 * read it: a Pause the server refused looked exactly like a Pause that worked, because the button
 * un-disabled itself and the state it was waiting for never arrived. `role="alert"` so a screen reader
 * hears it without going looking for it; `null` while there is nothing to say, so the layout is the
 * same as before whenever nothing has gone wrong.
 */
export default function ErrorNote({ error, className = '' }: { error: unknown; className?: string }) {
  if (!error) return null;
  return (
    <span role="alert" className={`text-[11px] break-words text-danger ${className}`}>
      {errorText(error)}
    </span>
  );
}
