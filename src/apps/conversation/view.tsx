import { useMemo } from 'react';
import { useStickToBottom } from '../../renderer/hooks';
import { renderMarkdown } from '../../renderer/markdown';
import type { ViewProps } from '../../renderer/viewTypes';
import { messageText, type ConversationState, type Message } from './index';

function Bubble({ m }: { m: Message }) {
  const text = messageText(m);
  const html = useMemo(() => (m.role === 'assistant' ? renderMarkdown(text) : ''), [m.role, text]);
  if (m.role === 'user') return <div className="msg user"><p>{text}</p></div>;
  return (
    <div className={`msg assistant${m.done ? '' : ' streaming'}`}>
      <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

export function ConversationView({ state, canvas }: ViewProps<ConversationState>) {
  const last = state.messages[state.messages.length - 1];
  const ref = useStickToBottom<HTMLDivElement>(last?.id, last ? messageText(last).length : 0);
  const working = canvas.session.activity === 'working' && !canvas.session.endedAt;
  return (
    <div className="conversation" ref={ref}>
      {state.messages.length === 0 && <div className="c-empty">Your conversation with Claude appears here.</div>}
      {state.messages.map((m) => <Bubble key={m.id} m={m} />)}
      {working && last?.role === 'user' && <div className="msg assistant thinking"><span /><span /><span /></div>}
    </div>
  );
}
