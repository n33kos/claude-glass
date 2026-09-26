import { useLayoutEffect, useRef } from 'react';

/**
 * Keep a scroll container at the bottom, like a live feed.
 * - `entries` changes (a new entry was posted): always jump to the bottom so it's visible.
 * - `growth` changes (e.g. a streaming message grows) or the box resizes: stay at the bottom only
 *   if the user hasn't scrolled up to read something.
 */
export function useStickToBottom<T extends HTMLElement>(entries: unknown, growth: unknown = entries) {
  const ref = useRef<T>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => { pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; };
    const ro = new ResizeObserver(() => { if (pinned.current) el.scrollTop = el.scrollHeight; });
    el.addEventListener('scroll', onScroll);
    ro.observe(el);
    return () => { el.removeEventListener('scroll', onScroll); ro.disconnect(); };
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    pinned.current = true;
  }, [entries]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [growth]);
  return ref;
}
