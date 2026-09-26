import { useLayoutEffect, useMemo, useRef } from 'react';
import { renderMarkdown } from '../../renderer/markdown';
import type { AppViewProps } from '../../sdk/react';
import type { MarkdownState } from './index';

export default function MarkdownView({ state }: AppViewProps<MarkdownState>) {
  const html = useMemo(() => renderMarkdown(state.content), [state.content]);
  const ref = useRef<HTMLDivElement>(null);
  const prev = useRef(state.content);
  // Newest content in view: an append scrolls to the bottom, a replacement starts at the top.
  useLayoutEffect(() => {
    const el = ref.current;
    const before = prev.current;
    prev.current = state.content;
    if (!el || before === state.content) return;
    el.scrollTop = before && state.content.startsWith(before) ? el.scrollHeight : 0;
  }, [state.content]);
  if (!state.content) return <div className="md-empty">Nothing here yet.</div>;
  return (
    <div className="markdown" ref={ref}>
      {state.source && <div className="md-source" title={state.source}>{state.source.split('/').pop()}</div>}
      <article className="md" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
