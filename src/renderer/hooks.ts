import { useLayoutEffect, useRef } from 'react';

/** Keep a scroll container pinned to the bottom while the user hasn't scrolled up. */
export function useStickToBottom<T extends HTMLElement>(dep: unknown) {
  const ref = useRef<T>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => { pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [dep]);
  return ref;
}
