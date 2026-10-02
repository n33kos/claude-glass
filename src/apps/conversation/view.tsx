import { useMemo, useState } from 'react';
import { useStickToBottom } from '../../renderer/hooks';
import { renderMarkdown } from '../../renderer/markdown';
import type { AppViewProps } from '../../sdk/react';
import { messageText, type ConversationState, type Message } from './index';

// Who's speaking shows once per run of messages: a label over the first of each.
function Bubble({ m, first }: { m: Message; first: boolean }) {
  const text = messageText(m);
  const html = useMemo(() => (m.role === 'assistant' ? renderMarkdown(text) : ''), [m.role, text]);
  if (m.role === 'user') return (
    <div className={`turn user${first ? ' first' : ''}`}>
      {first && <span className="who">You</span>}
      <div className="msg user"><p>{text}</p></div>
    </div>
  );
  return (
    <div className={`turn assistant${first ? ' first' : ''}`}>
      {first && <span className="who">Claude</span>}
      <div className={`msg assistant${m.done ? '' : ' streaming'}`}>
        <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </div>
  );
}

type Attached = { id: string; label: string; text: string };

/** Message Claude from here: sent as the user's prompt, once Claude is free, with whatever was
 *  attached from the glass (point and ask) as context Claude reads with it. */
function Composer({ host, working, attachments }: { host: AppViewProps['host']; working: boolean; attachments: Attached[] }) {
  const [text, setText] = useState('');
  const [sent, setSent] = useState(false);
  const send = () => {
    if (!text.trim()) return;
    host('prompt', { text });
    setText('');
    setSent(true);
    setTimeout(() => setSent(false), 3000);
  };
  return (
    <form className="composer" onSubmit={(e) => { e.preventDefault(); send(); }}>
      {attachments.length > 0 && (
        <div className="c-attached" aria-label="Goes with your next message">
          {attachments.map((a) => (
            <span key={a.id} className="c-chip" title={`Claude reads this with your next message:\n\n${a.text}`}>
              {a.label}
              <button type="button" aria-label={`Don't attach ${a.label}`} onClick={() => host('detach', { id: a.id })}>×</button>
            </span>
          ))}
        </div>
      )}
      <div className="c-row">
      <textarea value={text} rows={1} onChange={(e) => setText(e.target.value)} aria-label="Message Claude"
        placeholder={sent ? (working ? 'Sent: it goes in once Claude is free' : 'Sent') : 'Message Claude…'}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} />
      <button className="c-send" type="submit" disabled={!text.trim()} aria-label="Send" title="Send (Enter)">↑</button>
      </div>
    </form>
  );
}

export default function ConversationView({ state, session, host }: AppViewProps<ConversationState>) {
  const last = state.messages[state.messages.length - 1];
  const ref = useStickToBottom<HTMLDivElement>(last?.id, last ? messageText(last).length : 0);
  const working = session.activity === 'working' && !session.ended;
  return (
    <div className="conversation">
      <div className="c-list" ref={ref}>
        {state.messages.length === 0 && <div className="c-empty">Your conversation with Claude appears here.</div>}
        {state.messages.map((m, i) => <Bubble key={m.id} m={m} first={state.messages[i - 1]?.role !== m.role} />)}
        {working && last?.role === 'user' && <div className="turn assistant first"><span className="who">Claude</span><div className="msg assistant thinking"><span /><span /><span /></div></div>}
      </div>
      {!session.ended && <Composer host={host} working={working} attachments={session.attachments ?? []} />}
    </div>
  );
}
