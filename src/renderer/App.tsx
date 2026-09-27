import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { computeDesktops, desktopsFor, EDGES, edgeSize, effectiveLayout, LAYOUT_NAMES, LAYOUTS, nestedSlots, type DesktopPage } from '../core/layout';
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
interface Drag {
  id: string; px: number; py: number; ox: number; oy: number; // pointer, and its offset inside the window
  target: number | null; // layout slot it would land in
  tuck?: Edge | null; slot?: number | null; // sidebar it would pin to, and where in it
  from?: Edge; // dragging a window out of this sidebar
  mod?: boolean; // ⌘ held
}

type TuckState = { tucked?: Partial<Record<Edge, string[]>>; tuckKeep?: Edge[]; tuckSize?: Partial<Record<Edge, number>> };

/** Where an edge sidebar sits in a W×H stage (side sidebars full height; top/bottom between them). */
function panelRect(edge: Edge, W: number, H: number, s: TuckState): Rect {
  const sz = edgeSize(edge, W, H, s.tuckSize);
  const side = sideRoom(s, W, H);
  if (edge === 'left') return { x: PAD, y: PAD, w: sz, h: H - PAD * 2 };
  if (edge === 'right') return { x: W - PAD - sz, y: PAD, w: sz, h: H - PAD * 2 };
  const w = W - PAD * 2 - side.l - side.r;
  return { x: PAD + side.l, y: edge === 'top' ? PAD : H - PAD - sz, w, h: sz };
}

/** n equal slots along a sidebar (stacked on left/right, side by side on top/bottom), panel-relative. */
function panelSlots(edge: Edge, n: number, r: Rect): Rect[] {
  const vertical = edge === 'left' || edge === 'right';
  const each = ((vertical ? r.h : r.w) - GAP * (n - 1)) / n;
  return Array.from({ length: n }, (_, i) => (vertical ? { x: 0, y: i * (each + GAP), w: r.w, h: each } : { x: i * (each + GAP), y: 0, w: each, h: r.h }));
}

const TUCK_ZONE = 44; // px strip at each stage edge: with ⌘ held, drop a window there to pin it to that sidebar
const SWITCH_ZONE = 48; // left/right: hold a dragged window here to switch desktops
const PIN_TARGET = 30; // radius of the pin target shown mid-edge while dragging (drop on it to pin)
const PULL_ICON = 34; // icon cell in a sidebar's pull capsule
const PULL_T = 7; // the pull rail's thickness, and the capsule's margin around its icons

/** Room kept-open left/right sidebars take (top/bottom sidebars fit between them). */
function sideRoom(s: TuckState, W: number, H: number) {
  const room = (e: Edge) => (s.tuckKeep?.includes(e) && s.tucked?.[e]?.length ? edgeSize(e, W, H, s.tuckSize) + GAP : 0);
  return { l: room('left'), r: room('right') };
}

/** Center of an edge's pin target in stage coordinates (top/bottom: between kept side sidebars). */
function pinTargetCenter(edge: Edge, W: number, H: number, side: { l: number; r: number }): { x: number; y: number } {
  const mid = (W + side.l - side.r) / 2;
  return { left: { x: 34, y: H / 2 }, right: { x: W - 34, y: H / 2 }, top: { x: mid, y: 34 }, bottom: { x: mid, y: H - 34 } }[edge];
}

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
  const [dockDrag, setDockDrag] = useState<{ id: string; px: number; py: number; tuck: Edge | null; slot?: number | null; before: string | null } | null>(null);
  /**
   * Where a drag at (cx, cy) would pin: a sidebar kept open takes drops anywhere over it; a hidden
   * edge through its pin target (always shown while dragging), or its whole strip when `strips`
   * (⌘ held, or a dock icon drag).
   */
  const pinTarget = (cx: number, cy: number, strips: boolean, showing: Edge | null = null): Edge | null => {
    const st = stageRef.current?.getBoundingClientRect();
    if (!st || cx < st.left || cx > st.right || cy < st.top || cy > st.bottom) return null;
    // Open = kept open, or slid out right now (e.g. the sidebar a window is being dragged out of).
    const open = (e: Edge) => !!state.tucked?.[e]?.length && (!!state.tuckKeep?.includes(e) || e === showing);
    const side = sideRoom(state, st.width, st.height);
    const x = cx - st.left, y = cy - st.top;
    for (const e of EDGES) {
      if (!open(e)) continue;
      const r = panelRect(e, st.width, st.height, state);
      if (x >= r.x - GAP / 2 && x <= r.x + r.w + GAP / 2 && y >= r.y - GAP / 2 && y <= r.y + r.h + GAP / 2) return e;
    }
    for (const e of EDGES) {
      if (open(e)) continue;
      const c = pinTargetCenter(e, st.width, st.height, side);
      if (Math.hypot(x - c.x, y - c.y) <= PIN_TARGET) return e;
    }
    if (!strips) return null;
    const hit: Edge | null = cx - st.left < TUCK_ZONE ? 'left' : st.right - cx < TUCK_ZONE ? 'right'
      : cy - st.top < TUCK_ZONE ? 'top' : st.bottom - cy < TUCK_ZONE ? 'bottom' : null;
    return hit && !open(hit) ? hit : null;
  };
  /** Where in an open sidebar a window dropped at (cx, cy) would go (its other windows keep order). */
  const panelIndexAt = (edge: Edge, cx: number, cy: number, dragId: string): number => {
    const st = stageRef.current!.getBoundingClientRect();
    const r = panelRect(edge, st.width, st.height, state);
    const others = (state.tucked?.[edge] ?? []).filter((x) => x !== dragId);
    const vertical = edge === 'left' || edge === 'right';
    const pos = vertical ? (cy - st.top - r.y) / r.h : (cx - st.left - r.x) / r.w;
    return Math.max(0, Math.min(others.length, Math.floor(pos * (others.length + 1))));
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
    const room = (e: Edge) => (kept.includes(e) && state.tucked?.[e]?.length ? edgeSize(e, size.W, size.H, state.tuckSize) + GAP : 0);
    return { l: room('left'), r: room('right'), t: room('top'), b: room('bottom') };
  }, [size.W, size.H, kept.join(), state.tucked, state.tuckSize]); // eslint-disable-line react-hooks/exhaustive-deps
  const placed = useMemo(() => place(pages, size.W, size.H, focus, inset), [pages, size, focus, inset]);
  const opacityFor = (m: InstanceMeta) => m.opacity ?? state.settings.windowOpacity ?? config.windowOpacity;

  // ---- drag to reorder -------------------------------------------------------------
  const edgeTimer = useRef<number | null>(null);
  /** Start dragging a window by its title bar: one in the layout, or one pinned to a sidebar (`from`). */
  const onDragStart = (id: string, e: React.PointerEvent, from?: Edge) => {
    const win = (e.currentTarget as HTMLElement).closest('.window')?.getBoundingClientRect();
    if (!win) return;
    // Keep the pointer while dragging (app frames under it are also switched off, see CSS).
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    if (from) setPeek(from); // keep its sidebar out while dragging from it
    setDrag({ id, px: e.clientX, py: e.clientY, ox: e.clientX - win.left, oy: e.clientY - win.top, target: null, from });
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
    // A plain drag reorders; holding ⌘ offers the pin strips (open sidebars always take drops).
    let last = { x: 0, y: 0, mod: false };
    const update = (x: number, y: number, mod: boolean) => {
      last = { x, y, mod };
      const tuck = pinTarget(x, y, mod, drag.from ?? null);
      const open = tuck && (state.tuckKeep?.includes(tuck) || tuck === drag.from);
      const slot = open ? panelIndexAt(tuck, x, y, drag.id) : null;
      setDrag((d) => d && { ...d, px: x, py: y, target: targetAt(x, y), tuck, slot, mod });
      return tuck;
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Meta') update(last.x, last.y, e.type === 'keydown'); };
    const move = (e: PointerEvent) => {
      const tuck = update(e.clientX, e.clientY, e.metaKey);
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
      const tuck = pinTarget(e.clientX, e.clientY, e.metaKey, drag.from ?? null);
      const open = tuck && (state.tuckKeep?.includes(tuck) || tuck === drag.from);
      const target = targetAt(e.clientX, e.clientY);
      const cur = state.order.indexOf(drag.id);
      const history = state.settings.windowMode === 'history';
      // Pin (at the dropped position if the sidebar is open), including reordering within a sidebar.
      if (tuck) dispatch({ type: 'window.tuck', id: drag.id, edge: tuck, index: open ? panelIndexAt(tuck, e.clientX, e.clientY, drag.id) : undefined });
      // Dragged out of a sidebar onto the layout: unpin into that slot (history mode: newest first).
      else if (drag.from) dispatch({ type: 'window.untuck', id: drag.id, index: history ? undefined : target });
      // Reorder (history mode keeps time order). Final index = target; the reducer removes, then
      // inserts, and clamps past-the-end.
      else if (target !== cur && !history) dispatch({ type: 'window.move', id: drag.id, index: target });
      setDrag(null);
      setPeek(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    window.addEventListener('keydown', key);
    window.addEventListener('keyup', key);
    return () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      window.removeEventListener('keydown', key); window.removeEventListener('keyup', key);
    };
  }, [drag?.id, v, placed, pages, size.W, state.order, state.settings.windowMode, state.tucked, state.tuckKeep, state.tuckSize]); // eslint-disable-line react-hooks/exhaustive-deps

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
      const tuck = pinTarget(e.clientX, e.clientY, true);
      const slot = tuck && state.tuckKeep?.includes(tuck) ? panelIndexAt(tuck, e.clientX, e.clientY, id) : null;
      setDockDrag((d) => d && { ...d, px: e.clientX, py: e.clientY, tuck, slot, before: b === undefined ? null : b });
      document.querySelectorAll('.dock-item.drop-before, .dock.drop-end').forEach((el) => el.classList.remove('drop-before', 'drop-end'));
      if (b) document.querySelector(`.dock-item[data-dock-id="${CSS.escape(b)}"]`)?.classList.add('drop-before');
      else if (b === null) document.querySelector('.dock')?.classList.add('drop-end');
    };
    const up = (e: PointerEvent) => {
      document.querySelectorAll('.dock-item.drop-before, .dock.drop-end').forEach((el) => el.classList.remove('drop-before', 'drop-end'));
      const tuck = pinTarget(e.clientX, e.clientY, true);
      const b = beforeAt(e.clientX, e.clientY);
      setDockDrag(null);
      if (tuck) return void dispatch({ type: 'window.tuck', id, edge: tuck, index: state.tuckKeep?.includes(tuck) ? panelIndexAt(tuck, e.clientX, e.clientY, id) : undefined });
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
    <div className={`glass${config.dockAutoHide ? ' dock-autohide' : ''}${state.tucked?.bottom?.length ? ' has-bottom-pin' : ''}${glow}`}>
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

      <main className={`stage${drag || dockDrag ? ' dragging-any' : ''}`} ref={stageRef}>
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
                dropTarget={false}
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
          {/* Placeholder: where the dragged window will land in the layout (not while over a sidebar). */}
          {drag && !drag.tuck && drag.target != null && (state.settings.windowMode !== 'history') && (() => {
            const slot = placed.find((p) => p.index === drag.target);
            if (!slot || (!drag.from && slot.id === drag.id)) return null;
            return <div className="drop-ghost" style={{ width: slot.rect.w, height: slot.rect.h, transform: `translate(${slot.rect.x}px, ${slot.rect.y}px)` }} />;
          })()}
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
        {(drag?.mod || dockDrag) && EDGES.filter((e) => !(state.tuckKeep?.includes(e) && state.tucked?.[e]?.length) && e !== drag?.from)
          .map((e) => <div key={e} className={`tuck-zone ${e}${(drag ?? dockDrag)!.tuck === e ? ' on' : ''}`}><span>Pin</span></div>)}
        {/* Pin targets: drop a dragged window on one to pin it to that edge; anywhere else is a normal drag. */}
        {(drag || dockDrag) && EDGES.filter((e) => !(state.tuckKeep?.includes(e) && state.tucked?.[e]?.length) && e !== drag?.from).map((e) => {
          const c = pinTargetCenter(e, size.W, size.H, sideRoom(state, size.W, size.H));
          return <div key={e} className={`pin-target ${e}${(drag ?? dockDrag)!.tuck === e ? ' on' : ''}`} style={{ left: c.x, top: c.y }} title={`Pin ${e}`}>
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden><path d="M9.5 1.5l5 5-1.4.6-2.6 2.6.3 3.3-1.3 1.3-3-3-3.8 3.8H2v-.7l3.8-3.8-3-3 1.3-1.3 3.3.3 2.6-2.6z" /></svg>
          </div>;
        })}
        <EdgePanels W={size.W} H={size.H} peek={peek} setPeek={setPeek} onWindowDragStart={onDragStart}
          drag={drag ?? (dockDrag ? { id: dockDrag.id, px: dockDrag.px, py: dockDrag.py, ox: 0, oy: 0, tuck: dockDrag.tuck, slot: dockDrag.slot ?? null } : null)} />
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
          <button className="untuck" title="Unpin: put back in the layout" aria-label="Unpin window" onClick={() => dispatch({ type: 'window.untuck', id: meta.id })}>Unpin</button>
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
 * Edge sidebars ("pin" in the UI): windows pinned to an edge leave the tiling flow and live here,
 * the same on every desktop. Hidden, a sidebar is a slim tab and hovering anywhere along its edge
 * slides it out; kept open, the layout makes room and its inner edge drags to resize. Windows
 * split a sidebar evenly and stay mounted while hidden (a voice app keeps listening).
 */
function EdgePanels({ W, H, peek, setPeek, drag, onWindowDragStart }: {
  W: number; H: number; peek: Edge | null; setPeek: (e: Edge | null) => void;
  drag: Pick<Drag, 'id' | 'px' | 'py' | 'ox' | 'oy' | 'from' | 'tuck' | 'slot'> | null;
  onWindowDragStart: (id: string, e: React.PointerEvent, from: Edge) => void;
}) {
  const { state, config } = useSnapshot();
  const closeTimer = useRef<number | null>(null);
  const hold = (e: Edge) => { if (closeTimer.current) clearTimeout(closeTimer.current); closeTimer.current = null; setPeek(e); };
  // Pointer near an edge's pull (hovering the edge or its capsule): starts the pull-out animation,
  // and keeps an open sidebar open (it slides in under the pointer, which would otherwise count
  // as leaving it and close it again).
  const [near, setNear] = useState<Edge | null>(null);
  const enterPull = (e: Edge) => { setNear(e); if (closeTimer.current) clearTimeout(closeTimer.current); closeTimer.current = null; };
  const release = () => { closeTimer.current = window.setTimeout(() => setPeek(null), 350); };
  // Live size while dragging a sidebar's inner edge; committed to state on release.
  const [resizing, setResizing] = useState<{ edge: Edge; size: number } | null>(null);
  const startResize = (edge: Edge, e: React.PointerEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); // frames under the pointer would swallow the drag
    const stage = (e.currentTarget as HTMLElement).closest('.stage')!.getBoundingClientRect();
    const sizeAt = (x: number, y: number) => ({ left: x - stage.left, right: stage.right - x, top: y - stage.top, bottom: stage.bottom - y }[edge] - PAD);
    let size = edgeSize(edge, W, H, state.tuckSize);
    document.body.classList.add('frames-off');
    const move = (ev: PointerEvent) => { size = edgeSize(edge, W, H, { [edge]: sizeAt(ev.clientX, ev.clientY) }); setResizing({ edge, size }); };
    const up = () => {
      document.body.classList.remove('frames-off');
      window.removeEventListener('pointermove', move); setResizing(null); void dispatch({ type: 'tuck.size', edge, size });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  };
  return (
    <>
      {EDGES.map((edge) => {
        const ids = (state.tucked?.[edge] ?? []).filter((id) => state.instances[id]);
        if (!ids.length) return null;
        const vertical = edge === 'left' || edge === 'right';
        const kept = !!state.tuckKeep?.includes(edge);
        const open = peek === edge || kept || drag?.from === edge;
        // Side sidebars win: top/bottom ones fit between any kept-open left/right sidebars.
        const r = panelRect(edge, W, H, resizing?.edge === edge ? { ...state, tuckSize: { ...state.tuckSize, [edge]: resizing.size } } : state);
        const side = sideRoom(state, W, H);
        const pw = r.w, ph = r.h;
        // While a window is dragged over (or out of) this sidebar, the others reflow around a
        // placeholder slot where it will land; the dragged one follows the pointer.
        const dragged = drag && ids.includes(drag.id) ? drag.id : null;
        const others = ids.filter((id) => id !== dragged);
        const ghostAt = drag && drag.tuck === edge && drag.slot != null ? Math.min(drag.slot, others.length) : null;
        const slots = panelSlots(edge, Math.max(1, others.length + (ghostAt != null ? 1 : 0)), r);
        const slotOf = (i: number) => slots[ghostAt != null && i >= ghostAt ? i + 1 : i];
        const stage = drag ? document.querySelector('.stage')?.getBoundingClientRect() : undefined;
        return (
          <Fragment key={edge}>
            {(() => {
              // The drawer pull. Closed: a black rail running off the screen edge with a capsule of
              // the pinned apps' icons; hovering the edge or the capsule starts pulling it out, and
              // clicking opens the sidebar. Open (or kept open): the rail becomes a translucent
              // backing behind the whole sidebar, and the capsule rides out to the sidebar's inner
              // edge, its icons swapped for the keep-open chevron.
              const state3 = open ? 'open' : near === edge ? 'near' : 'idle';
              const capThick = PULL_ICON + PULL_T * 2;
              const capLen = ids.length * PULL_ICON + (ids.length - 1) * 6 + PULL_T * 2;
              // Where the closed capsule sits along the edge: the sidebar's middle, except the bottom
              // when the dock auto-hides there (the dock owns the middle), then left of it.
              const along = vertical ? r.y + r.h / 2 : edge === 'bottom' && config.dockAutoHide ? Math.max(r.x + capLen, W * 0.2) : r.x + r.w / 2;
              const B = 10; // how far the open backing extends past the sidebar
              const E = 6; // the open backing runs the screen's full length, inset so its rounded ends show
              let railStyle: React.CSSProperties;
              if (state3 === 'open') {
                railStyle = {
                  left: { left: -4, right: r.x - B, top: E, bottom: E }[edge],
                  top: { left: E, right: E, top: -4, bottom: r.y - B }[edge],
                  width: { left: r.x + r.w + B + 4, right: W - r.x + B + 4, top: W - E * 2, bottom: W - E * 2 }[edge],
                  height: { left: H - E * 2, right: H - E * 2, top: r.y + r.h + B + 4, bottom: H - r.y + B + 4 }[edge],
                };
              } else {
                const len = state3 === 'near' ? Math.max(capLen + 80, (vertical ? r.h : r.w) * 0.45) : capLen + 80;
                const depth = state3 === 'near' ? PULL_T + 8 : PULL_T + 4; // from 4px off-screen inward
                railStyle = vertical
                  ? { top: along - len / 2, height: len, width: depth, left: edge === 'left' ? -4 : W - depth + 4 }
                  : { left: along - len / 2, width: len, height: depth, top: edge === 'top' ? -4 : H - depth + 4 };
              }
              // The capsule's center: on the edge (eased in when near), or on the open backing's inner edge.
              const inset = state3 === 'near' ? capThick / 2 + 8 : capThick / 2;
              const [cx, cy] = state3 === 'open'
                ? { left: [r.x + r.w + B, r.y + r.h / 2], right: [r.x - B, r.y + r.h / 2], top: [r.x + r.w / 2, r.y + r.h + B], bottom: [r.x + r.w / 2, r.y - B] }[edge]
                : { left: [inset, along], right: [W - inset, along], top: [along, inset], bottom: [along, H - inset] }[edge];
              const openIt = () => hold(edge);
              const toggleKeep = () => { void dispatch({ type: 'tuck.keep', edge, keep: !kept }); if (kept) setPeek(null); };
              return (
                <>
                  {!kept && <div className={`edge-hot ${edge}`} onMouseEnter={() => enterPull(edge)} onMouseLeave={() => { setNear(null); release(); }} onClick={openIt} />}
                  <i className={`edge-rail ${edge} ${state3}`} style={railStyle} />
                  <button className={`edge-cap ${edge} ${state3}${kept ? ' kept' : ''}`} style={{ left: cx, top: cy }} aria-pressed={state3 === 'open' ? kept : undefined}
                    title={state3 === 'open' ? (kept ? 'Hide this sidebar (hover the edge to show it)' : 'Keep this sidebar open') : `Show ${ids.map((id) => state.instances[id].title).join(', ')}`}
                    onMouseEnter={() => enterPull(edge)} onMouseLeave={() => { setNear(null); release(); }} onClick={state3 === 'open' ? toggleKeep : openIt}>
                    {state3 === 'open'
                      // One chevron for every edge: points away from the edge to keep open, toward it to hide.
                      ? <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden
                          style={{ transform: `rotate(${({ left: 0, top: 90, right: 180, bottom: 270 }[edge]) + (kept ? 180 : 0)}deg)` }}>
                          <path d="M6 3.5L10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      : ids.map((id) => <span key={id}><AppIcon type={state.instances[id].type} /></span>)}
                  </button>
                </>
              );
            })()}
            <div className={`edge-panel ${edge}${open ? ' open' : ''}${kept ? ' kept' : ''}${drag?.tuck === edge ? ' drop-on' : ''}${resizing?.edge === edge ? ' resizing' : ''}`}
              style={{ width: pw, height: ph, ...(vertical ? {} : { left: PAD + side.l }) }} onMouseEnter={() => hold(edge)} onMouseLeave={release}>
              {kept && <div className={`edge-resize ${edge}`} title="Drag to resize" onPointerDown={(e) => startResize(edge, e)} />}
              {ghostAt != null && <div className="drop-ghost" style={{ width: slots[ghostAt].w, height: slots[ghostAt].h, transform: `translate(${slots[ghostAt].x}px, ${slots[ghostAt].y}px)` }} />}
              {ids.map((id) => {
                const meta = state.instances[id];
                const isDragged = id === dragged && drag && stage;
                // The dragged window keeps its size and follows the pointer (panel-relative).
                const home = slotOf(Math.max(0, others.indexOf(id))) ?? slots[0];
                const own = panelSlots(edge, ids.length, r)[ids.indexOf(id)];
                const style: React.CSSProperties = isDragged
                  ? { width: own.w, height: own.h, zIndex: 5, transform: `translate(${drag.px - stage.left - r.x - drag.ox}px, ${drag.py - stage.top - r.y - drag.oy}px) scale(.97)` }
                  : { width: home.w, height: home.h, transform: `translate(${home.x}px, ${home.y}px)` };
                const opacity = meta.opacity ?? state.settings.windowOpacity ?? config.windowOpacity;
                return (
                  <WindowFrame key={id} meta={meta} style={style} dragging={!!isDragged} dropTarget={false} opacity={opacity} tucked={edge}
                    onDragStart={(e) => onWindowDragStart(id, e, edge)}>
                    <AppBody id={id} meta={meta} w={isDragged ? own.w : home.w} h={isDragged ? own.h : home.h} />
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

