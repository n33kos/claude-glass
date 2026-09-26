import { useMemo } from 'react';
import { renderMarkdown } from '../../renderer/markdown';
import type { ViewProps } from '../../renderer/viewTypes';
import type { MarkdownState } from './index';

export function MarkdownView({ state }: ViewProps<MarkdownState>) {
  const html = useMemo(() => renderMarkdown(state.content), [state.content]);
  if (!state.content) return <div className="md-empty">Nothing here yet.</div>;
  return (
    <div className="markdown">
      {state.source && <div className="md-source" title={state.source}>{state.source.split('/').pop()}</div>}
      <article className="md" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
