import { useEffect, useRef, useState } from 'react';

const NEAR_BOTTOM = 40;
const SETTLE_MS = 200;
const isAtBottom = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM;

/** Pins a scroll container to its bottom while following; scrolling away from the bottom stops it. */
export default function useFollowBottom<T extends HTMLElement>(initial: boolean, dep: unknown) {
  const ref = useRef<T>(null);
  const [follow, setFollow] = useState(initial);
  const followRef = useRef(initial);
  const settleUntil = useRef(0);

  const pin = () => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  };

  // Effect is unavoidable: imperative DOM scrolling after React has committed the new content.
  useEffect(() => {
    followRef.current = follow;
    if (follow) pin();
  }, [follow, dep]);

  // Effect is unavoidable: subscribing to the container's native scroll events and to ResizeObserver —
  // both live outside React; the cleanup releases the listener and the observer. The container is
  // flex-sized, so a layout change above it resizes it and shifts the bottom; re-pin instead of
  // reading that as the user scrolling away.
  useEffect(() => {
    const el = ref.current;
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
  }, []);

  return { ref, follow, setFollow };
}
