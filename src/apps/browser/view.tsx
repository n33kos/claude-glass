import { useEffect, useState } from 'react';
import { fileUrl, timeAgo, type ViewProps } from '../../renderer/viewTypes';
import type { BrowserState, WebActivity } from './index';

type Frames = Partial<Record<'cdp' | 'web', string>>;

export function BrowserView({ id, state }: ViewProps<BrowserState>) {
  const [frames, setFrames] = useState<Frames>({});

  useEffect(() => {
    let alive = true;
    window.glass.lastFrame(id).then((f) => { if (alive && f) setFrames((p) => ({ ...f, ...p })); });
    const off = window.glass.onFrame((f) => { if (f.id === id) setFrames((p) => ({ ...p, [f.source]: f.data })); });
    return () => { alive = false; off(); };
  }, [id]);

  // A new page starts blank instead of showing the previous page's last frame.
  const pageUrl = state.web?.kind === 'page' ? state.web.url : null;
  useEffect(() => { setFrames((p) => ({ ...p, web: undefined })); }, [pageUrl]);

  const bar = barFor(state);
  return (
    <div className="browserview">
      <div className="b-bar">
        <span className={`b-dot ${bar.dot}`} />
        <span className="b-url" title={bar.url}>{bar.url}</span>
        <span className="b-meta">{bar.meta}</span>
      </div>
      <div className="b-stage">{stage(state, frames)}</div>
    </div>
  );
}

function barFor(s: BrowserState): { dot: string; url: string; meta: string } {
  switch (s.view) {
    case 'cdp': return { dot: s.status, url: s.url || s.endpoint || '', meta: s.status === 'live' ? 'live' : 'reconnecting' };
    case 'shot': return { dot: 'shot', url: s.shot?.url || s.shot?.title || 'screenshot', meta: `screenshot · ${timeAgo(s.shot?.at ?? s.updatedAt)}` };
    case 'web': {
      const w = s.web!;
      if (w.kind === 'search') return { dot: w.results ? 'web' : 'busy', url: `Search: ${w.query}`, meta: w.results ? `${w.results.length} results` : 'searching…' };
      return { dot: 'web', url: w.url, meta: w.title ? truncate(w.title, 40) : 'reading…' };
    }
    default: return { dot: 'off', url: 'no browser', meta: '' };
  }
}

function stage(s: BrowserState, frames: Frames) {
  if (s.view === 'web' && s.web) return s.web.kind === 'search' ? <SearchResults web={s.web} /> : frame(frames.web, s.web.title ?? s.web.url, false, <Loading url={s.web.url} />);
  if (s.view === 'shot' && s.shot) return frame(fileUrl(s.shot.file), s.shot.title ?? 'screenshot', false, null, true);
  if (s.view === 'cdp' && s.endpoint) {
    const stale = s.status !== 'live';
    return frame(frames.cdp, s.title ?? 'browser', stale, (
      <div className="b-empty">
        <div>Waiting for a browser at <code>{s.endpoint}</code></div>
        <div className="b-hint">Launch Chromium headless with <code>--remote-debugging-port={new URL(s.endpoint).port || '9222'}</code></div>
      </div>
    ));
  }
  return (
    <div className="b-empty">
      <div>Web searches and pages Claude reads show up here.</div>
      <div className="b-hint">Driving a browser? <code>claude-glass app browser attach</code> streams any Chromium DevTools port</div>
    </div>
  );
}

function frame(data: string | undefined, alt: string, stale: boolean, fallback: React.ReactNode, isUrl = false) {
  if (!data) return fallback;
  return <img src={isUrl ? data : `data:image/jpeg;base64,${data}`} alt={alt} draggable={false} className={stale ? 'stale' : ''} />;
}

function Loading({ url }: { url: string }) {
  let host = url;
  try { host = new URL(url).hostname; } catch {}
  return <div className="b-empty"><div className="b-spin" /><div>Opening {host}…</div></div>;
}

function SearchResults({ web }: { web: Extract<WebActivity, { kind: 'search' }> }) {
  if (!web.results) return <div className="b-empty"><div className="b-spin" /><div>Searching for “{web.query}”</div></div>;
  if (!web.results.length) return <div className="b-empty">No results for “{web.query}”</div>;
  return (
    <ol className="b-results">
      {web.results.map((r, i) => {
        let host = r.url;
        try { host = new URL(r.url).hostname.replace(/^www\./, ''); } catch {}
        return (
          <li key={i}>
            <div className="b-r-host">{host}</div>
            <div className="b-r-title">{r.title}</div>
          </li>
        );
      })}
    </ol>
  );
}

const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
