import { useState } from 'react';
import type { StackId } from '../../server/config-types';
import { useUnlockStack } from '../hooks/use-stack';
import { Button, inputStyle } from '../setup/ui';

/**
 * Asks for the sudo password of the user Sloth runs as — the one thing Sloth cannot work out by
 * itself on a Linux box where `sudo -n` is refused. It is typed here, posted once and dropped: the
 * field is cleared before the request is even awaited, the mutation is reset when it settles, and the
 * server spends it on `/etc/sudoers.d/sloth` without writing it anywhere. Nothing else in the UI ever
 * sees it.
 */
export default function SudoDialog({ root, ids, onClose }: { root?: string; ids: StackId[]; onClose: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const unlock = useUnlockStack(root);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || unlock.isPending) return;
    const value = password;
    setPassword('');
    setError(undefined);
    try {
      const status = await unlock.mutateAsync({ password: value, ids });
      if (status.installError) setError(status.installError);
      else onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      // react-query holds the last variables until it is reset, and those are the password.
      unlock.reset();
    }
  };

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <form
        role="dialog"
        aria-label="Install with a password"
        className="w-full max-w-sm space-y-3 rounded-lg border border-zinc-800 bg-zinc-950 p-4"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <div className="flex items-center">
          <h2 className="text-sm font-semibold text-zinc-100">Install with a password</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="ml-auto text-zinc-400 hover:text-zinc-200">
            ✕
          </button>
        </div>
        <p className="text-xs leading-relaxed text-zinc-400">
          The password of the user Sloth runs as is used <b className="text-zinc-200">once, right now</b>, to write{' '}
          <code className="text-zinc-300">/etc/sudoers.d/sloth</code> — the line that lets Sloth run <code>apt-get</code>,{' '}
          <code>service</code>, <code>systemctl</code> and <code>createuser</code> without a password, and nothing else. It is
          then forgotten: never stored, never logged, never written to disk, never given to a session. An AI session then
          installs what is missing, here on this page.
        </p>
        <input
          type="password"
          autoComplete="off"
          autoFocus
          spellCheck={false}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="sudo password"
          aria-label="sudo password"
          className={inputStyle}
        />
        {error && <p className="text-xs break-words text-red-400">{error}</p>}
        <div className="flex gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <span className="ml-auto">
            <Button type="submit" variant="primary" disabled={!password || unlock.isPending}>
              {unlock.isPending ? 'Unlocking…' : 'Unlock and install'}
            </Button>
          </span>
        </div>
      </form>
    </div>
  );
}
