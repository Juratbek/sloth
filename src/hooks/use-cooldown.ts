import { useEffect, useState } from 'react';

/**
 * A button's "just pressed" state that ends on its own: `arm()` starts the cooldown, `cooling` turns
 * false when it runs out — by a timer, not by whatever re-render happens to come along next.
 */
export default function useCooldown(ms: number): { cooling: boolean; arm: () => void } {
  const [until, setUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  // Effect is unavoidable: the clock lives outside React; the timer wakes the component once the
  // cooldown is over and the cleanup drops it when a new one is armed or the button unmounts.
  useEffect(() => {
    const left = until - Date.now();
    if (left <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), left);
    return () => clearTimeout(timer);
  }, [until]);
  return { cooling: until > now, arm: () => setUntil(Date.now() + ms) };
}
