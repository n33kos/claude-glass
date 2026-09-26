import { useEffect, useRef, useState } from 'react';
import { fileUrl, timeAgo } from '../../renderer/viewTypes';
import glass from '../../sdk/glass-app';
import type { AppViewProps } from '../../sdk/react';
import { currentWeb, type BrowserState, type WebActivity } from './index';

type Frames = Partial<Record<'cdp' | 'web', string>>;

export default function BrowserView({ state, run, host }: AppViewProps<BrowserState>) {
  const [frames, setFrames] = useState<Frames>({});
  const [listOpen, setListOpen] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);

  // Tell main the stage's shape so fetched pages render to fill it.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => { if (el.clientHeight > 0) host('aspect', { value: (el.clientWidth - 20) / (el.clientHeight - 20) }); }, 150);
    });
    ro.observe(el);
    return () => { ro.disconnect(); clearTimeout(t); };
  }, []);

  useEffect(() => glass.onFrame((f) => setFrames((p) => ({ ...p, [f.source]: f.data }))), []);

  // A new page starts blank instead of showing the previous page's last frame.
  const web = currentWeb(state);
  const pageUrl = web?.kind === 'page' ? web.url : null;
  useEffect(() => { setFrames((p) => ({ ...p, web: undefined })); }, [pageUrl]);

  // Back/forward walk the web history. From the live browser or a screenshot, back shows the
  // latest web entry. View-only: nothing here reaches Claude.
  const history = state.history ?? [];
  const n = history.length;
  const at = state.view === 'web' ? (state.cursor >= 0 && state.cursor < n ? state.cursor : n - 1) : n;
  const go = (i: number) => { setListOpen(false); run('web.go', { index: i }); };

  const bar = barFor(state);
  return (
    <div className="browserview">
      <div className="b-bar">
        <span className="b-nav">
          <button disabled={at <= 0} onClick={() => go(at - 1)} aria-label="Back" title="Back">‹</button>
          <button disabled={at >= n - 1} onClick={() => go(at + 1)} aria-label="Forward" title="Forward">›</button>
        </span>
        <span className={`b-dot ${bar.dot}`} />
        <span className="b-url" title={bar.url}>{bar.url}</span>
        <span className="b-meta">{bar.meta}</span>
        {n > 0 && (
          <button className={`b-hist-btn${listOpen ? ' on' : ''}`} onClick={() => setListOpen((v) => !v)} title="History">
            {at < n ? `${at + 1} / ${n}` : `${n}`} ▾
          </button>
        )}
      </div>
      {state.view === 'web' && web?.kind === 'page' && (state.away || web.highlight) && (
        <div className={`b-note${state.away ? ' away' : ''}`}>
          {state.away
            ? <><span>You're browsing <b>{hostOf(state.away)}</b>. This isn't the page Claude read.</span>
                <button onClick={() => run('web.home')}>Back to Claude's page</button></>
            : <span>Highlighted: “{truncate(web.highlight!, 90)}”{web.found === 0 ? ' · not found on the page' : web.found ? ` · ${web.found} match${web.found === 1 ? '' : 'es'}` : ''}</span>}
        </div>
      )}
      <div className="b-stage" ref={stageRef}>
        {state.view === 'web' && web?.kind === 'page' && frames.web
          ? <LivePage data={frames.web} alt={web.title ?? web.url} host={host} />
          : stage(state, web, frames)}
        {listOpen && <HistoryList history={history} at={at} onPick={go} onClose={() => setListOpen(false)} />}
      </div>
    </div>
  );
}

function HistoryList({ history, at, onPick, onClose }: { history: WebActivity[]; at: number; onPick: (i: number) => void; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  // Newest first, like a browser's history menu.
  const rows = history.map((h, i) => ({ h, i })).reverse();
  return (
    <div className="b-hist" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <ol>
        {rows.map(({ h, i }) => (
          <li key={i} className={i === at ? 'on' : ''} onClick={() => onPick(i)}>
            <span className="b-h-kind">{h.kind === 'search' ? '⌕' : '◳'}</span>
            <span className="b-h-text">
              <span className="b-h-title">{h.kind === 'search' ? h.query : h.title || hostOf(h.url)}</span>
              <span className="b-h-sub">{h.kind === 'search' ? (h.results ? `search · ${h.results.length} results` : 'search · …') : h.url}</span>
            </span>
            <span className="b-h-time">{timeAgo(h.at)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

function barFor(s: BrowserState): { dot: string; url: string; meta: string } {
  switch (s.view) {
    case 'cdp': return { dot: s.status, url: s.url || s.endpoint || '', meta: s.status === 'live' ? 'live' : 'reconnecting' };
    case 'shot': return { dot: 'shot', url: s.shot?.url || s.shot?.title || 'screenshot', meta: `screenshot · ${timeAgo(s.shot?.at ?? s.updatedAt)}` };
    case 'web': {
      const w = currentWeb(s);
      if (!w) return { dot: 'off', url: '', meta: '' };
      if (w.kind === 'search') return { dot: w.results ? 'web' : 'busy', url: `Search: ${w.query}`, meta: w.results ? `${w.results.length} results` : 'searching…' };
      return { dot: 'web', url: w.url, meta: w.title ? truncate(w.title, 40) : 'reading…' };
    }
    default: return { dot: 'off', url: 'no browser', meta: '' };
  }
}

function stage(s: BrowserState, web: WebActivity | undefined, frames: Frames) {
  if (s.view === 'web' && web) return web.kind === 'search' ? <SearchResults web={web} /> : frame(frames.web, web.title ?? web.url, false, <Loading url={web.url} />);
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

/** The glass's own copy of a fetched page: scroll and click go to it (never to Claude's browser). */
function LivePage({ data, alt, host }: { data: string; alt: string; host: AppViewProps['host'] }) {
  // Where on the page (0..1) a point on the image is. The image is contained, top-centered.
  const at = (img: HTMLImageElement, cx: number, cy: number) => {
    const r = img.getBoundingClientRect();
    const k = Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight);
    const w = img.naturalWidth * k, h = img.naturalHeight * k;
    return { x: (cx - (r.left + (r.width - w) / 2)) / w, y: (cy - r.top) / h };
  };
  return (
    <img className="b-live" src={`data:image/jpeg;base64,${data}`} alt={alt} draggable={false}
      onWheel={(e) => host('page-input', { type: 'wheel', ...at(e.currentTarget, e.clientX, e.clientY), deltaX: e.deltaX, deltaY: e.deltaY })}
      onClick={(e) => {
        const p = at(e.currentTarget, e.clientX, e.clientY);
        if (p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1) host('page-input', { type: 'click', ...p });
      }} />
  );
}
