import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { invalidateLive } from '../lib/live-keys';

/** Refetches the live queries whenever the server reports a transcript / watcher file change. */
export default function useLiveUpdates() {
  const queryClient = useQueryClient();
  // Effect is unavoidable: subscribing to the server's EventSource stream, closed on unmount.
  useEffect(() => {
    const source = new EventSource('/api/events');
    source.onmessage = (e) => {
      if (e.data === 'change') invalidateLive(queryClient);
    };
    return () => source.close();
  }, [queryClient]);
}
