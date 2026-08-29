import { useState } from 'react';
import type { StackChoice } from '../../server/config-types';
import StackPanel from '../components/StackPanel';
import { Button } from './ui';
import type { Draft } from './use-setup';

/** What the app needs on this machine — PostgreSQL, Redis, a runtime — installed before the first session runs. */
export default function StepStack({ draft, onBack, onContinue }: { draft: Draft; onBack: () => void; onContinue: (patch: Partial<Draft>) => void }) {
  const [stack, setStack] = useState<StackChoice>(draft.stack);
  return (
    <div className="space-y-4">
      <p className="text-sm text-zinc-400">
        A session boots the app to verify its change and leaves it up as a preview — which needs the app's database and runtime on
        this machine. Sloth reads the checkout to see what that is and installs what is missing (Homebrew here, apt-get on Debian /
        Ubuntu); every start of Sloth installs whatever is still missing.
      </p>
      <StackPanel root={draft.runnerRoot} value={stack} onChange={setStack} />
      <div className="flex gap-2">
        <Button onClick={onBack}>Back</Button>
        <Button variant="primary" onClick={() => onContinue({ stack })}>
          Continue
        </Button>
      </div>
    </div>
  );
}
