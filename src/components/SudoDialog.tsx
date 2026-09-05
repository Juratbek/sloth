import { useState } from 'react';
import type { StackId } from '../../server/config-types';
import { useUnlockStack } from '../hooks/use-stack';
import { inputStyle } from '../setup/ui';
import Button from './ui/Button';
import Modal from './ui/Modal';

/**
 * Asks for the sudo password of the user Sloth runs as — the one thing Sloth cannot work out by
 * itself on a Linux box where `sudo -n` is refused. It is typed here, posted once and dropped: the
 * field is cleared before the request is even awaited, the POST is a plain one so no cache keeps it
 * (`useUnlockStack`), and the server spends it on `/etc/sudoers.d/sloth` without writing it anywhere.
 * Nothing else in the UI ever sees it.
 *
 * The form sits inside the dialog rather than being it, so `Modal` owns the backdrop, Escape and the
 * focus trap while Enter in the field still submits. `data-autofocus` is what tells `Modal` to leave
 * the focus here instead of on the close button.
 */
export default function SudoDialog({ root, ids, onClose }: { root?: string; ids: StackId[]; onClose: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const { unlock, isPending } = useUnlockStack(root);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || isPending) return;
    const value = password;
    setPassword('');
    setError(undefined);
    try {
      const status = await unlock({ password: value, ids });
      if (status.installError) setError(status.installError);
      else onClose();
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <Modal title="Install with a password" onClose={onClose}>
      <form className="space-y-3" onSubmit={submit}>
        <p className="text-xs leading-relaxed text-zinc-400">
          The password of the user Sloth runs as is used <b className="text-zinc-200">once, right now</b>, to write{' '}
          <code className="text-zinc-300">/etc/sudoers.d/sloth</code> — the exact <code>apt-get</code>, <code>service</code>,{' '}
          <code>systemctl</code> and <code>createuser</code> lines the install runs, argument for argument, and nothing else. It is
          then forgotten: never stored, never logged, never written to disk, never given to a session. An AI session then
          installs what is missing, here on this page.
        </p>
        <input
          type="password"
          autoComplete="off"
          data-autofocus
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
            <Button type="submit" variant="primary" disabled={!password || isPending}>
              {isPending ? 'Unlocking…' : 'Unlock and install'}
            </Button>
          </span>
        </div>
      </form>
    </Modal>
  );
}
