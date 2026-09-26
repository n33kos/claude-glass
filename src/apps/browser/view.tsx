import { useEffect, useState } from 'react';
import { fileUrl, timeAgo, type ViewProps } from '../../renderer/viewTypes';
import type { BrowserState } from './index';

export function BrowserView({ id, state }: ViewProps<BrowserState>) {
  const [live, setLive] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    window.glass.lastFrame(id).then((f) => { if (alive && f) setLive(f); });
    const off = window.glass.onFrame((f) => { if (f.id === id) setLive(f.data); });
    return () => { alive = false; off(); };
  }, [id]);

  const src = state.status === 'pushed' && state.frame ? fileUrl(state.frame)
    : live && state.endpoint ? `data:image/jpeg;base64,${live}` : null;
  const stale = state.status === 'waiting' && !!src;

  return (
    <div className="browserview">
      <div className="b-bar">
        <span className={`b-dot ${state.status}`} title={state.status} />
        <span className="b-url" title={state.url}>{state.url || state.endpoint || 'no browser'}</span>
        <span className="b-meta">
          {state.status === 'live' ? 'live' : state.status === 'pushed' ? `screenshot · ${timeAgo(state.updatedAt)}` : state.status === 'waiting' ? 'reconnecting' : ''}
        </span>
      </div>
      <div className="b-stage">
        {src ? <img src={src} alt={state.title ?? 'browser'} draggable={false} className={stale ? 'stale' : ''} />
          : state.status === 'waiting' ? (
            <div className="b-empty">
              <div>Waiting for a browser at <code>{state.endpoint}</code></div>
              <div className="b-hint">Launch Chromium with <code>--remote-debugging-port={new URL(state.endpoint!).port || '9222'}</code></div>
            </div>
          ) : (
            <div className="b-empty">
              <div>The browser Claude drives shows up here.</div>
              <div className="b-hint"><code>claude-glass app browser attach</code> streams any Chromium DevTools port</div>
            </div>
          )}
      </div>
    </div>
  );
}
