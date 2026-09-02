import { useCallback, useEffect, useRef, useState } from 'react';

const NEAR_BOTTOM = 40;
const SETTLE_MS = 200;
const isAtBottom = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM;

/**
 * Pins a scroll container to its bottom while following; scrolling away from the bottom stops it.
 * `ref` is a callback ref: the container may mount after the hook's first run (a pane behind a "no
 * data yet" guard), and the scroll listener has to follow the element, not the first render.
 */
export default function useFollowBottom<T extends HTMLElement>(initial: boolean, dep: unknown) {
  const [el, setEl] = useState<T | null>(null);
  const [follow, setFollow] = useState(initial);
  const followRef = useRef(initial);
  const settleUntil = useRef(0);
  const ref = useCallback((node: T | null) => setEl(node), []);

  const pin = () => {
    if (el) el.scrollTop = el.scrollHeight;
  };

  // Effect is unavoidable: imperative DOM scrolling after React has committed the new content.
  useEffect(() => {
    followRef.current = follow;
    if (follow) pin();
  }, [follow, dep, el]);

  // Effect is unavoidable: subscribing to the container's native scroll events and to ResizeObserver —
  // both live outside React; the cleanup releases the listener and the observer. The container is
  // flex-sized, so a layout change above it resizes it and shifts the bottom; re-pin instead of
  // reading that as the user scrolling away. Re-run for every element the callback ref hands over.
  useEffect(() => {
    if (!el) return;
    const onScroll = () => {
      if (performance.now() < settleUntil.current) {
        if (followRef.current) pin();
        return;
      }
      followRef.current = isAtBottom(el);
      setFollow(followRef.current);
    };
    const observer = new ResizeObserver(() => {
      settleUntil.current = performance.now() + SETTLE_MS;
      if (followRef.current) pin();
    });
    el.addEventListener('scroll', onScroll, { passive: true });
    observer.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      observer.disconnect();
    };
  }, [el]);

  return { ref, follow, setFollow };
}
