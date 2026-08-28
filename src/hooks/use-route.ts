import { useSyncExternalStore } from 'react';

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

// The history is outside React and outlives every component that reads it, so one listener for the life
// of the page is all it takes: back and forward fire `popstate`, `navigate` calls `notify` itself.
addEventListener('popstate', notify);

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const snapshot = () => location.pathname;

/** Goes to `path` without a page load. `replace` swaps the current history entry instead of adding one. */
export function navigate(path: string, { replace = false }: { replace?: boolean } = {}): void {
  if (path === location.pathname) return;
  if (replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  notify();
}

/**
 * The current path, kept in step with the browser's own history. This is the one hook allowed to
 * subscribe outside React — `popstate` is exactly that — and `src/lib/routes.ts` turns the path it
 * returns into a page. Everything that changes page calls `navigate`.
 */
export default function useRoute(): { path: string; navigate: typeof navigate } {
  return { path: useSyncExternalStore(subscribe, snapshot), navigate };
}
