import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { computeDesktops, desktopsFor, EDGES, effectiveLayout, panelSize, LAYOUT_NAMES, LAYOUTS, nestedSlots, type DesktopPage } from '../core/layout';
import type { Edge, InstanceMeta, LayoutName, Waiting } from '../core/types';
import { wallpaper } from './backgrounds';
import { AppIcon } from './AppIcon';
import { FrameView } from './FrameView';
import { apps, dispatch, useSnapshot } from './store';
import { VIEWS } from './views';

const PAD = 12;
const GAP = 12;

interface Rect { x: number; y: number; w: number; h: number }
interface Placed { id: string; page: number; index: number; rect: Rect; hidden?: boolean; far?: boolean }
interface Drag { id: string; px: number; py: number; ox: number; oy: number; target: number | null; tuck?: Edge | null }

const TUCK_ZONE = 44; // px strip at each stage edge: drop a window there to tuck it
const SWITCH_ZONE = 88; // left/right, just inside the tuck strip: hold to switch desktops

type Inset = { l: number; r: number; t: number; b: number };

/** Tile the desktops into the stage, minus room for any edge panels kept open. */
function place(pages: DesktopPage[], W: number, H: number, focus: number, ins: Inset): Placed[] {
  const out: Placed[] = [];
  const iw = W - PAD * 2 - ins.l - ins.r, ih = H - PAD * 2 - ins.t - ins.b;
  for (const p of pages) {
    // Nested: windows before the focus are scrolled past (hidden, parked in the big pane);
    // windows past the spiral's depth are parked in its smallest pane.
    const nested = p.layout === 'nested';
    const f = nested ? Math.min(focus, p.windows.length - 1) : 0;
    const slots = nested ? nestedSlots(p.windows.length - f) : LAYOUTS[effectiveLayout(p)].slots;
    p.windows.forEach((id, i) => {
      const k = i - f;
      const hidden = nested && (k < 0 || k >= slots.length);
      const far = nested && (k < -2 || k >= slots.length + 2); // virtualized: frame only, no app view
      const s = slots[Math.max(0, Math.min(k, slots.length - 1))];
      const x = p.index * W + PAD + ins.l + s.x * iw + (s.x > 0 ? GAP / 2 : 0);
      const y = PAD + ins.t + s.y * ih + (s.y > 0 ? GAP / 2 : 0);
      const w = s.w * iw - (s.x > 0 ? GAP / 2 : 0) - (s.x + s.w < 0.999 ? GAP / 2 : 0);
      const h = s.h * ih - (s.y > 0 ? GAP / 2 : 0) - (s.y + s.h < 0.999 ? GAP / 2 : 0);
      out.push({ id, page: p.index, index: p.start + i, rect: { x, y, w, h }, hidden, far });
    });
  }
  return out;
}

export function App() {
  const { state, config } = useSnapshot();
  const pages = useMemo(() => computeDesktops(state.order, desktopsFor(state.desktops, config.nestedView), config.defaultLayout),
    [state.order, state.desktops, config.defaultLayout, config.nestedView]);
  const [view, setViewRaw] = useState(0);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [peek, setPeek] = useState<Edge | null>(null); // edge panel slid out (hover or dock)
  // Dragging a dock icon: along the dock reorders windows; onto an edge's Tuck strip tucks it.
  const [dockDrag, setDockDrag] = useState<{ id: string; px: number; py: number; tuck: Edge | null; before: string | null } | null>(null);
  const tuckAtPoint = (cx: number, cy: number): Edge | null => {
    const st = stageRef.current?.getBoundingClientRect();
    if (!st) return null;
    return cx - st.left < TUCK_ZONE && cy > st.top && cy < st.bottom ? 'left' : st.right - cx < TUCK_ZONE && cy > st.top && cy < st.bottom ? 'right'
      : cy >= st.top && cy - st.top < TUCK_ZONE ? 'top' : cy <= st.bottom && st.bottom - cy < TUCK_ZONE ? 'bottom' : null;
  };
  // Nested layout: which window is in the big pane (by id, so new windows don't move you; null = newest).
  const [focusId, setFocusId] = useState<string | null>(null);
  const nestedPage = pages.find((p) => p.layout === 'nested');
  const focus = nestedPage && focusId ? Math.max(0, nestedPage.windows.indexOf(focusId)) : 0;
  const stepFocus = (d: number) => {
    if (!nestedPage) return false;
    const i = Math.max(0, Math.min(nestedPage.windows.length - 1, focus + d));
    setFocusId(i === 0 ? null : nestedPage.windows[i]);
    return true;
  };
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
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && pages[v]?.layout === 'nested') stepFocus(e.key === 'ArrowDown' ? 1 : -1);
      if (e.key === 'ArrowRight') setView(Math.min(v + 1, pages.length - 1));
      if (e.key === 'ArrowLeft') setView(v - 1);
    };
    let acc = 0, cool = 0;
    const onWheel = (e: WheelEvent) => {
      const target = e.target as HTMLElement;
      // Horizontal swipe anywhere; vertical scroll (mouse wheels) only outside windows, if enabled.
      const horizontal = Math.abs(e.deltaX) >= Math.abs(e.deltaY) * 1.5;
      // Nested desktop: vertical scroll outside the content (gaps, bars, title bars) walks the spiral.
      if (!horizontal && pages[v]?.layout === 'nested' && !target.closest?.('.body, .layout-menu, .question-card, .lightbox')) {
        const now = Date.now();
        if (now < cool) return;
        acc += e.deltaY;
        if (Math.abs(acc) > 60) { stepFocus(Math.sign(acc)); acc = 0; cool = now + 350; }
        return;
      }
      const vertical = !horizontal && config.wheelDesktops && !target.closest?.('.window, .layout-menu, .question-card, .lightbox');
      if (!horizontal && !vertical) return;
      if (target.closest?.('.scroll-x')) return;
      const now = Date.now();
      if (now < cool) return;
      acc += horizontal ? e.deltaX : e.deltaY;
      if (Math.abs(acc) > 90) {
        setView(Math.max(0, Math.min(pages.length - 1, v + Math.sign(acc))));
        acc = 0; cool = now + 650;
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('wheel', onWheel, { passive: true });
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('wheel', onWheel); };
  }, [v, pages, setView, config.wheelDesktops, focus]); // eslint-disable-line react-hooks/exhaustive-deps

  // Edge panels kept open take their space from the layout.
  const kept = state.tuckKeep ?? [];
  const inset = useMemo(() => {
    const { side, band } = panelSize(size.W, size.H);
    const has = (e: Edge) => kept.includes(e) && !!state.tucked?.[e]?.length;
    return { l: has('left') ? side + GAP : 0, r: has('right') ? side + GAP : 0, t: has('top') ? band + GAP : 0, b: has('bottom') ? band + GAP : 0 };
  }, [size.W, size.H, kept.join(), state.tucked]); // eslint-disable-line react-hooks/exhaustive-deps
  const placed = useMemo(() => place(pages, size.W, size.H, focus, inset), [pages, size, focus, inset]);
  const opacityFor = (m: InstanceMeta) => m.opacity ?? state.settings.windowOpacity ?? config.windowOpacity;

  // ---- drag to reorder -------------------------------------------------------------
  const edgeTimer = useRef<number | null>(null);
  const onDragStart = (id: string, e: React.PointerEvent) => {
    const p = placed.find((x) => x.id === id);
    if (!p) return;
    const stage = stageRef.current!.getBoundingClientRect();
    // Keep the pointer while dragging: app views are frames, and a frame under the pointer would
    // otherwise swallow the moves and the release.
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
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
    // Dropping in an edge strip tucks the window there.
    const tuckAt = (cx: number, cy: number): Edge | null =>
      cx - stage.left < TUCK_ZONE ? 'left' : stage.right - cx < TUCK_ZONE ? 'right'
        : cy - stage.top < TUCK_ZONE ? 'top' : stage.bottom - cy < TUCK_ZONE ? 'bottom' : null;
    const move = (e: PointerEvent) => {
      const tuck = tuckAt(e.clientX, e.clientY);
      setDrag((d) => d && { ...d, px: e.clientX, py: e.clientY, target: targetAt(e.clientX, e.clientY), tuck });
      const dl = e.clientX - stage.left, dr = stage.right - e.clientX;
      const nearLeft = !tuck && dl < SWITCH_ZONE, nearRight = !tuck && dr < SWITCH_ZONE;
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
      const tuck = tuckAt(e.clientX, e.clientY);
      const target = targetAt(e.clientX, e.clientY);
      const cur = state.order.indexOf(drag.id);
      if (tuck) dispatch({ type: 'window.tuck', id: drag.id, edge: tuck });
      // Reorder (history mode keeps time order: dragging there only tucks). Final index = target;
      // the reducer removes, then inserts, and clamps past-the-end.
      else if (target !== cur && state.settings.windowMode !== 'history') dispatch({ type: 'window.move', id: drag.id, index: target });
      setDrag(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  }, [drag?.id, v, placed, pages, size.W, state.order, state.settings.windowMode]);

  useEffect(() => { if (!drag && view > pages.length - 1) setViewRaw(pages.length - 1); }, [drag, pages.length, view]);

  // Dock icon drags (started by the Dock once the pointer moves a few px).
  useEffect(() => {
    if (!dockDrag) return;
    const id = dockDrag.id;
    // The dock icon the pointer is before (null = after the last), for a reorder drop.
    const beforeAt = (cx: number, cy: number): string | null | undefined => {
      const dock = document.querySelector('.dock')?.getBoundingClientRect();
      if (!dock || cy < dock.top - 24 || cy > dock.bottom + 24) return undefined; // not over the dock
      for (const el of document.querySelectorAll<HTMLElement>('.dock-item[data-dock-id]')) {
        const r = el.getBoundingClientRect();
        if (cx < r.left + r.width / 2) return el.dataset.dockId!;
      }
      return null;
    };
    const move = (e: PointerEvent) => {
      const b = beforeAt(e.clientX, e.clientY);
      setDockDrag((d) => d && { ...d, px: e.clientX, py: e.clientY, tuck: tuckAtPoint(e.clientX, e.clientY), before: b === undefined ? null : b });
      document.querySelectorAll('.dock-item.drop-before, .dock.drop-end').forEach((el) => el.classList.remove('drop-before', 'drop-end'));
      if (b) document.querySelector(`.dock-item[data-dock-id="${CSS.escape(b)}"]`)?.classList.add('drop-before');
      else if (b === null) document.querySelector('.dock')?.classList.add('drop-end');
    };
    const up = (e: PointerEvent) => {
      document.querySelectorAll('.dock-item.drop-before, .dock.drop-end').forEach((el) => el.classList.remove('drop-before', 'drop-end'));
      const tuck = tuckAtPoint(e.clientX, e.clientY);
      const b = beforeAt(e.clientX, e.clientY);
      setDockDrag(null);
      if (tuck) return void dispatch({ type: 'window.tuck', id, edge: tuck });
      if (b === undefined || state.settings.windowMode === 'history' || config.dockOrder === 'fixed' || b === id) return;
      // Reorder: the window lands where its icon was dropped among the open windows.
      const open = state.order.filter((x) => x !== id);
      const idx = b === null ? open.length : Math.max(0, open.indexOf(b));
      const target = b !== null && idx === -1 ? open.length : idx;
      void (state.order.includes(id) ? Promise.resolve() : dispatch({ type: 'window.open', id }))
        .then(() => dispatch({ type: 'window.move', id, index: target }));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  }, [dockDrag?.id, state.order, state.settings.windowMode, config.dockOrder]); // eslint-disable-line react-hooks/exhaustive-deps

  const s = state.session;
  const waiting = s.endedAt ? undefined : s.waiting;
  const presence = s.endedAt ? 'ended' : waiting ? 'waiting' : s.activity;
  const rel = (t: string) => (s.cwd ? t.split(s.cwd + '/').join('') : t);
  const glow = waiting && config.waitingGlow ? ' waiting-glow' : '';
  return (
    <div className={`glass${config.dockAutoHide ? ' dock-autohide' : ''}${glow}`}>
      <Wallpaper bg={config.background} animate={config.animateBackground} />
      <header className="topbar">
        <div className="session">
          <span className="project">{s.title}</span>
          <span className={`presence presence-${presence}`} title={waiting ? `${rel(waiting.summary)} (answer in Claude Code)` : undefined}>
            <i />
            {waiting ? 'Waiting on you' : presence === 'working' ? 'Claude is working' : presence === 'ended' ? 'Session ended' : 'Idle'}
            {waiting && <span className="presence-detail">{waiting.kind === 'permission' ? 'Permission' : 'Question'}: {rel(waiting.summary)}</span>}
          </span>
        </div>
        <nav className="pager" aria-label="Desktops">
          {pages.map((p) => (
            <button key={p.index} className={p.index === v ? 'on' : ''} onClick={() => setView(p.index)} title={`Desktop ${p.index + 1}`} />
          ))}
        </nav>
      </header>

      {waiting?.kind === 'question' && <QuestionCard waiting={waiting} />}

      <main className={`stage${drag ? ' dragging-any' : ''}`} ref={stageRef}>
        <div className="strip" style={{ transform: `translateX(${-v * size.W}px)` }}>
          {/* Stable DOM order (by id): windows are placed by transform, so a reorder never moves
              a node, and app frames never reload. */}
          {[...placed].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((p) => {
            const meta = state.instances[p.id];
            if (!meta) return null;
            const dragging = drag?.id === p.id;
            const style: React.CSSProperties = dragging
              ? { width: p.rect.w, height: p.rect.h, transform: `translate(${drag.px - (stageRef.current?.getBoundingClientRect().left ?? 0) - drag.ox + v * size.W}px, ${drag.py - (stageRef.current?.getBoundingClientRect().top ?? 0) - drag.oy}px) scale(.97)` }
              : { width: p.rect.w, height: p.rect.h, transform: `translate(${p.rect.x}px, ${p.rect.y}px)`,
                  ...(p.hidden ? { opacity: 0, pointerEvents: 'none' as const } : {}) };
            return (
              <WindowFrame
                key={p.id}
                meta={meta}
                style={style}
                dragging={dragging}
                dropTarget={!!drag && !dragging && drag.target === p.index}
                opacity={opacityFor(meta)}
                page={pages[p.page]}
                onDragStart={(e) => onDragStart(p.id, e)}
              >
                {/* Virtualization: only windows near what's on screen mount their app view. */}
                {dragging || (!p.far && Math.abs(p.page - v) <= 1)
                  ? <AppBody id={p.id} meta={meta} w={p.rect.w} h={p.rect.h} />
                  : <div className="app-parked" />}
              </WindowFrame>
            );
          })}
          {nestedPage && (() => {
            const newer = focus, older = Math.max(0, nestedPage.windows.length - focus - 6);
            const left = nestedPage.index * size.W;
            return (<>
              {newer > 0 && <button className="nest-badge top" style={{ left: left + size.W / 2 }} onClick={() => setFocusId(null)}>↑ {newer} newer</button>}
              {older > 0 && <span className="nest-badge bottom" style={{ left: left + size.W - 90 }}>{older} older ↓</span>}
            </>);
          })()}
          {pages.every((p) => p.windows.length === 0) && !EDGES.some((e) => state.tucked?.[e]?.length) && (
            <div className="empty" style={{ width: size.W }}>
              <p>Nothing on screen. Open an app from the dock, or ask Claude to show you something.</p>
            </div>
          )}
        </div>
        {(drag || dockDrag) && EDGES.map((e) => <div key={e} className={`tuck-zone ${e}${(drag ?? dockDrag)!.tuck === e ? ' on' : ''}`}><span>Tuck</span></div>)}
        <EdgePanels W={size.W} H={size.H} peek={peek} setPeek={setPeek} />
      </main>

      {config.dockAutoHide && <div className="dock-hot" aria-hidden />}
      {dockDrag && <div className="dock-ghost" style={{ left: dockDrag.px, top: dockDrag.py }}><span className={`tile tile-${state.instances[dockDrag.id]?.type}`}><AppIcon type={state.instances[dockDrag.id]?.type} /></span></div>}
      <Dock pages={pages} viewing={v} width={size.W} dragging={dockDrag} onDragStart={(id, x, y) => setDockDrag({ id, px: x, py: y, tuck: null, before: null })} onReveal={(id) => {
        const edge = EDGES.find((e) => state.tucked?.[e]?.includes(id));
        if (edge) return setPeek(edge);
        const p = placed.find((x) => x.id === id);
        setView(p ? p.page : 0);
      }} />
    </div>
  );
}

function Wallpaper({ bg, animate }: { bg: string; animate: boolean }) {
  const w = useMemo(() => wallpaper(bg), [bg]);
  return (
    <div className={`wallpaper${animate ? ' drifting' : ''}`} style={w.style} aria-hidden>
      {w.blobs.map((b, i) => <div key={i} className={`bokeh bokeh-${i % 4}`} style={b.style} />)}
    </div>
  );
}

/** Read-only on purpose: options are plain text, not buttons. Answering happens in Claude Code. */
function QuestionCard({ waiting }: { waiting: Waiting }) {
  const qs = waiting.questions?.length ? waiting.questions : [{ question: waiting.summary, options: [] }];
  return (
    <aside className="question-card" aria-live="polite">
      {qs.map((q, i) => (
        <div key={i} className="qc-q">
          {q.header && <span className="qc-header">{q.header}</span>}
          <p className="qc-text">{q.question}</p>
          {q.options.length > 0 && (
            <ul className="qc-options">
              {q.options.map((o, j) => (
                <li key={j}><span className="qc-label">{o.label}</span>{o.description && <span className="qc-desc">{o.description}</span>}</li>
              ))}
            </ul>
          )}
        </div>
      ))}
      <p className="qc-foot">Answer in Claude Code</p>
    </aside>
  );
}

function AppBody({ id, meta, w, h }: { id: string; meta: InstanceMeta; w: number; h: number }) {
  const { state, config } = useSnapshot();
  const app = apps[meta.type];
  const View = app?.frame ? null : VIEWS[meta.type];
  const appState = state.appState[id] ?? null;
  const run = useCallback((command: string, args: Record<string, unknown> = {}) => dispatch({ type: 'app.command', id, command, args }), [id]);
  if (app?.frame) return <FrameView app={app} id={id} meta={meta} state={appState} width={w} height={h - 36} glass={state} run={run} />;
  if (!View) return <div className="app-missing">No view for “{meta.type}”.</div>;
  return <View id={id} meta={meta} state={appState} width={w} height={h - 36} run={run} glass={state} config={config} />;
}

function WindowFrame(props: {
  meta: InstanceMeta; style: React.CSSProperties; dragging: boolean; dropTarget: boolean; opacity: number;
  page?: DesktopPage; onDragStart?: (e: React.PointerEvent) => void; children: React.ReactNode; tucked?: Edge;
}) {
  const { meta, page, tucked } = props;
  const [menu, setMenu] = useState(false);
  const app = apps[meta.type];
  const history = useSnapshot().state.settings.windowMode === 'history';
  return (
    <section
      className={`window${props.dragging ? ' dragging' : ''}${props.dropTarget ? ' drop-target' : ''}`}
      style={{ ...props.style, ['--glass' as any]: props.opacity }}
      data-window={meta.id}
    >
      <div className="titlebar" onPointerDown={(e) => { if (!props.onDragStart || (e.target as HTMLElement).closest('button')) return; e.preventDefault(); props.onDragStart(e); }}>
        <div className="lights">
          <button className="light close" title="Close window" aria-label="Close window" onClick={() => dispatch({ type: 'window.close', id: meta.id })} />
          {!history && !tucked && <button className="light front" title="Move to first slot" aria-label="Move to first slot" onClick={() => dispatch({ type: 'window.move', id: meta.id, index: 0 })} />}
          {page && page.layout !== 'nested' && <button className="light layout" title="Desktop layout" aria-label="Change desktop layout" onClick={() => setMenu((m) => !m)} />}
        </div>
        <span className="wtitle" title={`${meta.title} · id: ${meta.id}`}><em><AppIcon type={meta.type} /></em>{meta.title}</span>
        {tucked ? (
          <button className="untuck" title="Put back in the layout" aria-label="Untuck window" onClick={() => dispatch({ type: 'window.untuck', id: meta.id })}>Untuck</button>
        ) : null}
        {menu && page && (
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

function Dock({ pages, viewing, onReveal, onDragStart, dragging, width }: {
  pages: DesktopPage[]; viewing: number; onReveal: (id: string) => void; width: number;
  onDragStart: (id: string, x: number, y: number) => void; dragging: { id: string } | null;
}) {
  const { state, config } = useSnapshot();
  // Press + move a few px = drag (reorder along the dock, or onto an edge to tuck); else a click.
  const press = useRef<{ id: string; x: number; y: number; started: boolean } | null>(null);
  const onPointerDown = (id: string, e: React.PointerEvent) => {
    press.current = { id, x: e.clientX, y: e.clientY, started: false };
    const move = (ev: PointerEvent) => {
      const p = press.current;
      if (!p || p.started || Math.hypot(ev.clientX - p.x, ev.clientY - p.y) < 6) return;
      p.started = true;
      onDragStart(p.id, ev.clientX, ev.clientY);
    };
    const up = () => { window.removeEventListener('pointermove', move); setTimeout(() => { press.current = null; }, 0); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  };
  const clickable = (fn: () => void) => () => { if (!press.current?.started) fn(); };
  const open = new Set(pages.flatMap((p) => p.windows));
  const pageOf = new Map(pages.flatMap((p) => p.windows.map((id) => [id, p.index] as const)));
  // Apps on desktops you aren't looking at are dimmed, so the dock reads like a strip of screens.
  const offScreen = (id: string) => pageOf.has(id) && pageOf.get(id) !== viewing;
  const group = (id: string) => pageOf.get(id) ?? -1; // -1 = closed
  const tile = new Map(pages.flatMap((p) => p.windows).map((id, i) => [id, i]));
  const rank = (m: InstanceMeta) => (m.type === 'conversation' ? 0 : m.type === 'terminal' ? 1 : 2);
  const fixed = (a: InstanceMeta, b: InstanceMeta) => rank(a) - rank(b) || a.createdAt - b.createdAt;
  // "windows": open apps in tile order (left to right = first slot onward), closed apps after.
  const byWindows = (a: InstanceMeta, b: InstanceMeta) =>
    (tile.get(a.id) ?? Infinity) - (tile.get(b.id) ?? Infinity) || fixed(a, b);
  const off = new Set(config.disabledApps ?? []);
  const items = Object.values(state.instances).filter((m) => m.type !== 'settings' && !off.has(m.type))
    .sort(config.dockOrder === 'fixed' ? fixed : byWindows);
  const settingsOpen = open.has('settings');
  // Crowded dock: icons shrink to fit the window (38px → 26px); past that the dock scrolls.
  const tileSize = Math.max(26, Math.min(38, Math.floor((width - 80) / (items.length + 1) - 5)));
  const crowded = (items.length + 1) * (tileSize + 5) + 60 > width;
  return (
    <footer className="dock-wrap">
      <div className={`dock${crowded ? ' crowded' : ''}${dragging ? ' dragging' : ''}`} style={{ ['--tile' as any]: `${tileSize}px` }}>
        {items.map((m, i) => (
          <Fragment key={m.id}>
            {config.dockOrder !== 'fixed' && i > 0 && group(items[i - 1].id) !== group(m.id) && <span className="dock-sep screen" />}
            <button className={`dock-item${offScreen(m.id) ? ' off-screen' : ''}${dragging?.id === m.id ? ' lifted' : ''}`} title={m.title} data-dock-id={m.id}
              onPointerDown={(e) => onPointerDown(m.id, e)}
              onClick={clickable(() => (open.has(m.id) ? onReveal(m.id) : dispatch({ type: 'window.open', id: m.id }).then(() => onReveal(m.id))))}>
              <span className={`tile tile-${m.type}${apps[m.type]?.iconUrl ? ' has-img' : ''}`}><AppIcon type={m.type} /></span>
              <span className="label">{m.title}</span>
              {open.has(m.id) && <i className="running" />}
            </button>
          </Fragment>
        ))}
        <span className="dock-sep" />
        <button className={`dock-item${offScreen('settings') ? ' off-screen' : ''}`} title="Settings"
          onClick={() => (settingsOpen ? onReveal('settings') : dispatch({ type: 'instance.create', appType: 'settings' }).then(() => onReveal('settings')))}>
          <span className="tile tile-settings">{apps.settings?.icon}</span>
          <span className="label">Settings</span>
          {settingsOpen && <i className="running" />}
        </button>
      </div>
    </footer>
  );
}

/**
 * Windows tucked into an edge: out of the tiling flow, the same on every desktop. Each edge is a
 * panel that sits off-screen with a slim tab and slides out on hover; its windows split the panel
 * evenly. They stay mounted while hidden (a voice app keeps listening).
 */
function EdgePanels({ W, H, peek, setPeek }: { W: number; H: number; peek: Edge | null; setPeek: (e: Edge | null) => void }) {
  const { state, config } = useSnapshot();
  const closeTimer = useRef<number | null>(null);
  const hold = (e: Edge) => { if (closeTimer.current) clearTimeout(closeTimer.current); closeTimer.current = null; setPeek(e); };
  const release = () => { closeTimer.current = window.setTimeout(() => setPeek(null), 350); };
  const { side, band } = panelSize(W, H);
  return (
    <>
      {EDGES.map((edge) => {
        const ids = (state.tucked?.[edge] ?? []).filter((id) => state.instances[id]);
        if (!ids.length) return null;
        const vertical = edge === 'left' || edge === 'right';
        const pw = vertical ? side : W - PAD * 2, ph = vertical ? H - PAD * 2 : band;
        const kept = !!state.tuckKeep?.includes(edge);
        const n = ids.length;
        const each = ((vertical ? ph : pw) - GAP * (n - 1)) / n;
        return (
          <Fragment key={edge}>
            {!kept && <div className={`edge-tab ${edge}`} onMouseEnter={() => hold(edge)} onMouseLeave={release} onClick={() => hold(edge)}>
              {ids.map((id) => <span key={id} title={state.instances[id].title}><AppIcon type={state.instances[id].type} /></span>)}
            </div>}
            <div className={`edge-panel ${edge}${peek === edge || kept ? ' open' : ''}${kept ? ' kept' : ''}`} style={{ width: pw, height: ph }}
              onMouseEnter={() => hold(edge)} onMouseLeave={release}>
              {/* Handle on the inner edge: keep this panel open (the layout makes room) or let it hide. */}
              <button className="edge-keep" title={kept ? 'Hide this panel (hover the edge to show it)' : 'Keep this panel open'}
                aria-pressed={kept} onClick={() => { void dispatch({ type: 'tuck.keep', edge, keep: !kept }); if (kept) setPeek(null); }}>
                {{ left: kept ? '‹' : '›', right: kept ? '›' : '‹', top: kept ? '˄' : '˅', bottom: kept ? '˅' : '˄' }[edge]}
              </button>
              {ids.map((id, i) => {
                const meta = state.instances[id];
                const w = vertical ? pw : each, h = vertical ? each : ph;
                const style: React.CSSProperties = { width: w, height: h, transform: `translate(${vertical ? 0 : i * (each + GAP)}px, ${vertical ? i * (each + GAP) : 0}px)` };
                const opacity = meta.opacity ?? state.settings.windowOpacity ?? config.windowOpacity;
                return (
                  <WindowFrame key={id} meta={meta} style={style} dragging={false} dropTarget={false} opacity={opacity} tucked={edge}>
                    <AppBody id={id} meta={meta} w={w} h={h} />
                  </WindowFrame>
                );
              })}
            </div>
          </Fragment>
        );
      })}
    </>
  );
}

