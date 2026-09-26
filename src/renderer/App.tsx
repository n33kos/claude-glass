import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { APPS } from '../apps/registry';
import { computeDesktops, effectiveLayout, LAYOUT_NAMES, LAYOUTS, type DesktopPage } from '../core/layout';
import type { InstanceMeta, LayoutName } from '../core/types';
import { backgroundStyle } from './backgrounds';
import { dispatch, useSnapshot } from './store';
import { VIEWS } from './views';

const PAD = 12;
const GAP = 12;

interface Rect { x: number; y: number; w: number; h: number }
interface Placed { id: string; page: number; index: number; rect: Rect }
interface Drag { id: string; px: number; py: number; ox: number; oy: number; target: number | null }

function place(pages: DesktopPage[], W: number, H: number): Placed[] {
  const out: Placed[] = [];
  const iw = W - PAD * 2, ih = H - PAD * 2;
  for (const p of pages) {
    const slots = LAYOUTS[effectiveLayout(p)].slots;
    p.windows.forEach((id, i) => {
      const s = slots[i];
      const x = p.index * W + PAD + s.x * iw + (s.x > 0 ? GAP / 2 : 0);
      const y = PAD + s.y * ih + (s.y > 0 ? GAP / 2 : 0);
      const w = s.w * iw - (s.x > 0 ? GAP / 2 : 0) - (s.x + s.w < 0.999 ? GAP / 2 : 0);
      const h = s.h * ih - (s.y > 0 ? GAP / 2 : 0) - (s.y + s.h < 0.999 ? GAP / 2 : 0);
      out.push({ id, page: p.index, index: p.start + i, rect: { x, y, w, h } });
    });
  }
  return out;
}

export function App() {
  const { state, config } = useSnapshot();
  const pages = useMemo(() => computeDesktops(state.order, state.desktops, config.defaultLayout), [state.order, state.desktops, config.defaultLayout]);
  const [view, setViewRaw] = useState(0);
  const [drag, setDrag] = useState<Drag | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ W: 1200, H: 800 });

  const maxView = pages.length - 1 + (drag ? 1 : 0); // while dragging, allow one empty desktop past the end
  const v = Math.min(view, maxView);
  const setView = useCallback((n: number) => {
    const next = Math.max(0, n);
    setViewRaw(next);
    dispatch({ type: 'ui.viewDesktop', index: next });
  }, []);

  useLayoutEffect(() => {
    const el = stageRef.current!;
    const ro = new ResizeObserver(() => setSize({ W: el.clientWidth, H: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Keyboard + horizontal swipe to change desktops.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === 'ArrowRight') setView(Math.min(v + 1, pages.length - 1));
      if (e.key === 'ArrowLeft') setView(v - 1);
    };
    let acc = 0, cool = 0;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) < Math.abs(e.deltaY) * 1.5) return;
      if ((e.target as HTMLElement).closest?.('.scroll-x')) return;
      const now = Date.now();
      if (now < cool) return;
      acc += e.deltaX;
      if (Math.abs(acc) > 90) {
        setView(Math.max(0, Math.min(pages.length - 1, v + Math.sign(acc))));
        acc = 0; cool = now + 650;
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('wheel', onWheel, { passive: true });
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('wheel', onWheel); };
  }, [v, pages.length, setView]);

  const placed = useMemo(() => place(pages, size.W, size.H), [pages, size]);
  const opacityFor = (m: InstanceMeta) => m.opacity ?? state.settings.windowOpacity ?? config.windowOpacity;

  // ---- drag to reorder -------------------------------------------------------------
  const edgeTimer = useRef<number | null>(null);
  const onDragStart = (id: string, e: React.PointerEvent) => {
    const p = placed.find((x) => x.id === id);
    if (!p) return;
    const stage = stageRef.current!.getBoundingClientRect();
    setDrag({ id, px: e.clientX, py: e.clientY, ox: e.clientX - stage.left - (p.rect.x - v * size.W), oy: e.clientY - stage.top - p.rect.y, target: null });
  };

  useEffect(() => {
    if (!drag) return;
    const stage = stageRef.current!.getBoundingClientRect();
    const targetAt = (cx: number, cy: number): number => {
      const x = cx - stage.left + v * size.W, y = cy - stage.top;
      const hit = placed.find((p) => p.id !== drag.id && p.page === v && x >= p.rect.x && x <= p.rect.x + p.rect.w && y >= p.rect.y && y <= p.rect.y + p.rect.h);
      if (hit) return hit.index;
      const page = pages[v];
      if (!page) return state.order.length; // empty desktop past the end
      const self = placed.find((p) => p.id === drag.id);
      if (self && self.page === v && x >= self.rect.x && x <= self.rect.x + self.rect.w && y >= self.rect.y && y <= self.rect.y + self.rect.h) return self.index;
      return Math.min(page.start + page.windows.length, state.order.length);
    };
    const move = (e: PointerEvent) => {
      setDrag((d) => d && { ...d, px: e.clientX, py: e.clientY, target: targetAt(e.clientX, e.clientY) });
      const nearLeft = e.clientX - stage.left < 28, nearRight = stage.right - e.clientX < 28;
      if ((nearLeft || nearRight) && edgeTimer.current == null) {
        edgeTimer.current = window.setTimeout(() => {
          edgeTimer.current = null;
          setViewRaw((cur) => Math.max(0, Math.min(pages.length, cur + (nearRight ? 1 : -1))));
        }, 450);
      } else if (!nearLeft && !nearRight && edgeTimer.current != null) {
        clearTimeout(edgeTimer.current); edgeTimer.current = null;
      }
    };
    const up = (e: PointerEvent) => {
      if (edgeTimer.current != null) { clearTimeout(edgeTimer.current); edgeTimer.current = null; }
      const target = targetAt(e.clientX, e.clientY);
      const cur = state.order.indexOf(drag.id);
      // Final index = target (the reducer removes, then inserts, and clamps past-the-end).
      if (target !== cur) dispatch({ type: 'window.move', id: drag.id, index: target });
      setDrag(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  }, [drag?.id, v, placed, pages, size.W, state.order]);

  useEffect(() => { if (!drag && view > pages.length - 1) setViewRaw(pages.length - 1); }, [drag, pages.length, view]);

  const s = state.session;
  const presence = s.endedAt ? 'ended' : s.activity;
  return (
    <div className="canvas" style={backgroundStyle(config.background)}>
      <header className="topbar">
        <div className="session">
          <span className="project">{s.title}</span>
          <span className={`presence presence-${presence}`}>
            <i />
            {presence === 'working' ? 'Claude is working' : presence === 'ended' ? 'Session ended' : 'Idle'}
          </span>
        </div>
        <nav className="pager" aria-label="Desktops">
          {pages.map((p) => (
            <button key={p.index} className={p.index === v ? 'on' : ''} onClick={() => setView(p.index)} title={`Desktop ${p.index + 1}`} />
          ))}
        </nav>
      </header>

      <main className="stage" ref={stageRef}>
        <div className="strip" style={{ transform: `translateX(${-v * size.W}px)` }}>
          {placed.map((p) => {
            const meta = state.instances[p.id];
            if (!meta) return null;
            const dragging = drag?.id === p.id;
            const style: React.CSSProperties = dragging
              ? { width: p.rect.w, height: p.rect.h, transform: `translate(${drag.px - (stageRef.current?.getBoundingClientRect().left ?? 0) - drag.ox + v * size.W}px, ${drag.py - (stageRef.current?.getBoundingClientRect().top ?? 0) - drag.oy}px) scale(.97)` }
              : { width: p.rect.w, height: p.rect.h, transform: `translate(${p.rect.x}px, ${p.rect.y}px)` };
            return (
              <WindowFrame
                key={p.id}
                meta={meta}
                pinned={state.pinned?.[p.id] != null}
                style={style}
                dragging={dragging}
                dropTarget={!!drag && !dragging && drag.target === p.index}
                opacity={opacityFor(meta)}
                page={pages[p.page]}
                onDragStart={(e) => onDragStart(p.id, e)}
              >
                <AppBody id={p.id} meta={meta} w={p.rect.w} h={p.rect.h} />
              </WindowFrame>
            );
          })}
          {pages.every((p) => p.windows.length === 0) && (
            <div className="empty" style={{ width: size.W }}>
              <p>Nothing on screen. Open an app from the dock, or ask Claude to show you something.</p>
            </div>
          )}
        </div>
      </main>

      <Dock pages={pages} onReveal={(id) => {
        const p = placed.find((x) => x.id === id);
        setView(p ? p.page : 0);
      }} />
    </div>
  );
}

function AppBody({ id, meta, w, h }: { id: string; meta: InstanceMeta; w: number; h: number }) {
  const { state, config } = useSnapshot();
  const View = VIEWS[meta.type];
  const app = APPS[meta.type];
  const appState = state.appState[id] ?? app?.init();
  const run = useCallback((command: string, args: Record<string, unknown> = {}) => dispatch({ type: 'app.command', id, command, args }), [id]);
  if (!View) return <div className="app-missing">No view for “{meta.type}”.</div>;
  return <View id={id} meta={meta} state={appState} width={w} height={h - 36} run={run} canvas={state} config={config} />;
}

function WindowFrame(props: {
  meta: InstanceMeta; pinned: boolean; style: React.CSSProperties; dragging: boolean; dropTarget: boolean; opacity: number;
  page: DesktopPage; onDragStart: (e: React.PointerEvent) => void; children: React.ReactNode;
}) {
  const { meta, page } = props;
  const [menu, setMenu] = useState(false);
  const app = APPS[meta.type];
  return (
    <section
      className={`window${props.dragging ? ' dragging' : ''}${props.dropTarget ? ' drop-target' : ''}`}
      style={{ ...props.style, ['--glass' as any]: props.opacity }}
      data-window={meta.id}
    >
      <div className="titlebar" onPointerDown={(e) => { if ((e.target as HTMLElement).closest('button')) return; e.preventDefault(); props.onDragStart(e); }}>
        <div className="lights">
          <button className="light close" title="Close window" aria-label="Close window" onClick={() => dispatch({ type: 'window.close', id: meta.id })} />
          <button className="light front" title="Move to first slot" aria-label="Move to first slot" onClick={() => dispatch({ type: 'window.move', id: meta.id, index: 0 })} />
          <button className="light layout" title="Desktop layout" aria-label="Change desktop layout" onClick={() => setMenu((m) => !m)} />
        </div>
        <span className="wtitle"><em>{app?.icon}</em>{meta.title}</span>
        <span className="wid">{meta.id}</span>
        <button className={`pin${props.pinned ? ' on' : ''}`} title={props.pinned ? 'Unpin from this slot' : 'Pin to this slot'}
          aria-label={props.pinned ? 'Unpin window' : 'Pin window'} aria-pressed={props.pinned}
          onClick={() => dispatch(props.pinned ? { type: 'window.unpin', id: meta.id } : { type: 'window.pin', id: meta.id })}>
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden><path d="M9.5 1.5l5 5-1.4.6-2.6 2.6.3 3.3-1.3 1.3-3-3-3.8 3.8H2v-.7l3.8-3.8-3-3 1.3-1.3 3.3.3 2.6-2.6z" /></svg>
        </button>
        {menu && (
          <div className="layout-menu" onMouseLeave={() => setMenu(false)}>
            {LAYOUT_NAMES.map((l) => (
              <button key={l} className={l === page.layout ? 'on' : ''} onClick={() => { dispatch({ type: 'desktop.layout', desktop: page.index, layout: l }); setMenu(false); }}>
                <LayoutGlyph name={l} />
                {LAYOUTS[l].label}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="body">{props.children}</div>
    </section>
  );
}

function LayoutGlyph({ name }: { name: LayoutName }) {
  return (
    <svg viewBox="0 0 30 20" width="30" height="20" aria-hidden>
      {LAYOUTS[name].slots.map((s, i) => (
        <rect key={i} x={s.x * 30 + 1} y={s.y * 20 + 1} width={s.w * 30 - 2} height={s.h * 20 - 2} rx="2" />
      ))}
    </svg>
  );
}

function Dock({ pages, onReveal }: { pages: DesktopPage[]; onReveal: (id: string) => void }) {
  const { state } = useSnapshot();
  const rank = (m: InstanceMeta) => (m.type === 'conversation' ? 0 : m.type === 'terminal' ? 1 : m.type === 'settings' ? 3 : 2);
  const items = Object.values(state.instances).filter((m) => m.type !== 'settings').sort((a, b) => rank(a) - rank(b) || a.createdAt - b.createdAt);
  const open = new Set(pages.flatMap((p) => p.windows));
  const settingsOpen = open.has('settings');
  return (
    <footer className="dock-wrap">
      <div className="dock">
        {items.map((m) => (
          <button key={m.id} className="dock-item" title={m.title}
            onClick={() => (open.has(m.id) ? onReveal(m.id) : dispatch({ type: 'window.open', id: m.id }).then(() => onReveal(m.id)))}>
            <span className={`tile tile-${m.type}`}>{APPS[m.type]?.icon}</span>
            <span className="label">{m.title}</span>
            {open.has(m.id) && <i className="running" />}
          </button>
        ))}
        <span className="dock-sep" />
        <button className="dock-item" title="Settings"
          onClick={() => (settingsOpen ? onReveal('settings') : dispatch({ type: 'instance.create', appType: 'settings' }).then(() => onReveal('settings')))}>
          <span className="tile tile-settings">{APPS.settings.icon}</span>
          <span className="label">Settings</span>
          {settingsOpen && <i className="running" />}
        </button>
      </div>
    </footer>
  );
}
