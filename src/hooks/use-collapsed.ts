import { useState } from 'react';

/**
 * A remembered open/closed flag, keyed in `localStorage`. There is nothing to subscribe to here — the
 * value is read once, in the state initializer, and written in the setter — so this hook holds no
 * effect: nobody else changes the key while the page is open.
 */
export default function useCollapsed(key: string): [boolean, (value: boolean) => void] {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(key) === '1';
    } catch {
      return false; // private mode, or no storage at all — start open
    }
  });
  const set = (value: boolean) => {
    setCollapsed(value);
    try {
      localStorage.setItem(key, value ? '1' : '0');
    } catch {
      /* not remembering the choice is not worth failing over */
    }
  };
  return [collapsed, set];
}
