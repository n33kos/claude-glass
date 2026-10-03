import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { computeDesktops, cornerHeight, cornerSides, desktopsFor, DOCKS, EDGES, edgeSize, effectiveLayout, isCorner, LAYOUT_NAMES, LAYOUTS, nestedSlots, type DesktopPage } from '../core/layout';
import type { Action, Corner, Dock, Edge, FreeRect, InstanceMeta, LayoutName, SessionUsage, Waiting } from '../core/types';
import { DEFAULT_PALETTES, lightColors, moodOf } from '../core/colors';
import { paintLights, wallpaper, type LightPainter } from './backgrounds';
import { AppIcon, iconSrc } from './AppIcon';
import { ThemeContext, useTheme } from './theme';
import { SignalLayer, TurnBar } from './SignalLayer';
import { FrameView } from './FrameView';
import { apps, dispatch, useSnapshot } from './store';
import { VIEWS } from './views';

const PAD = 12;
const GAP = 12;

interface Rect { x: number; y: number; w: number; h: number }
// scale < 1: the window is laid out at rect/scale and shrunk, a zoomed-out copy (carousel tiles).
interface Placed { id: string; page: number; index: number; rect: Rect; hidden?: boolean; far?: boolean; scale?: number }
interface Drag {
  id: string; px: number; py: number; ox: number; oy: number; // pointer, and its offset inside the window
  target: number | null; // layout slot it would land in
  tuck?: Dock | null; slot?: number | null; // dock it would land in, and where in it
  from?: Dock; // dragging a window out of this dock
  mod?: boolean; // ⌘ held
}

type TuckState = { tucked?: Partial<Record<Dock, string[]>>; tuckKeep?: Dock[]; tuckFloat?: Dock[]; tuckSize?: Partial<Record<Dock, number>>; tuckHeight?: Partial<Record<Corner, number>> };

const keptOpen = (s: TuckState, d: Dock) => !!s.tuckKeep?.includes(d) && !!s.tucked?.[d]?.length;
/** Kept open beside the layout: it takes its room (a floating dock doesn't). */
const takesRoom = (s: TuckState, d: Dock) => keptOpen(s, d) && !s.tuckFloat?.includes(d);
/** Docks whose windows stack (sides and corners); top/bottom ones sit side by side. */
const stacks = (d: Dock) => d !== 'top' && d !== 'bottom';

/**
 * Where a dock sits in a W×H stage. Kept-open docks on a side (its edge and its two corners) share
 * one column: the corners take its ends and the edge dock fits between them. Top/bottom docks fit
 * between the columns.
 */
function panelRect(edge: Dock, W: number, H: number, s: TuckState): Rect {
  const sz = edgeSize(edge, W, H, s.tuckSize);
  if (isCorner(edge)) {
    const [v, h] = cornerSides(edge);
    const ch = cornerHeight(edge, H, s.tuckHeight);
    return { x: h === 'left' ? PAD : W - PAD - sz, y: v === 'top' ? PAD : H - PAD - ch, w: sz, h: ch };
  }
  if (edge === 'left' || edge === 'right') {
    const end = (c: Corner) => (keptOpen(s, c) ? cornerHeight(c, H, s.tuckHeight) + GAP : 0);
    const top = end(`top-${edge}`), bottom = end(`bottom-${edge}`);
    return { x: edge === 'left' ? PAD : W - PAD - sz, y: PAD + top, w: sz, h: H - PAD * 2 - top - bottom };
  }
  const side = endRoom(s, W, H, edge);
  const w = W - PAD * 2 - side.l - side.r;
  return { x: PAD + side.l, y: edge === 'top' ? PAD : H - PAD - sz, w, h: sz };
}

/**
 * Room a top or bottom dock leaves for the side columns: only what reaches its end (the side edge
 * docks and that end's corners). A kept top-left corner doesn't shorten the bottom dock.
 */
function endRoom(s: TuckState, W: number, H: number, end: 'top' | 'bottom') {
  const col = (side: 'left' | 'right') => Math.max(0, ...([side, `${end}-${side}`] as Dock[])
    .filter((d) => keptOpen(s, d)).map((d) => edgeSize(d, W, H, s.tuckSize) + GAP));
  return { l: col('left'), r: col('right') };
}

/**
 * n slots along a dock (stacked on the sides and corners, side by side on top/bottom),
 * panel-relative: sized by `shares` when there's one per slot (the user dragged the gaps), else equal.
 */
function panelSlots(edge: Dock, n: number, r: Rect, shares?: number[]): Rect[] {
  const vertical = stacks(edge);
  const room = (vertical ? r.h : r.w) - GAP * (n - 1);
  const parts = shares?.length === n ? shares : Array.from({ length: n }, () => 1 / n);
  const total = parts.reduce((t, x) => t + x, 0);
  let at = 0;
  return parts.map((p) => {
    const len = (room * p) / total;
    const slot = vertical ? { x: 0, y: at, w: r.w, h: len } : { x: at, y: 0, w: len, h: r.h };
    at += len + GAP;
    return slot;
  });
}

const SPLIT_MIN = 90; // px: the smallest a window gets when dragging the gap between two in a dock

const TUCK_ZONE = 44; // px strip at each stage edge: with ⌘ held, drop a window there to dock it at that edge
const SWITCH_ZONE = 48; // left/right: hold a dragged window here to switch desktops
const PIN_TARGET = 30; // radius of the pin target shown mid-edge while dragging (drop on it to pin)
const PULL_ICON = 34; // icon cell in a dock's pull capsule
const PULL_T = 7; // the pull rail's thickness, and the capsule's margin around its icons
const CORNER_HOT = 56; // px square at a stage corner that hovers its corner dock (above the edges' strips)

/** Room the kept-open side columns take: the widest kept dock on each side (edge or corner). */
function sideRoom(s: TuckState, W: number, H: number) {
  const col = (side: 'left' | 'right') => Math.max(0, ...([side, `top-${side}`, `bottom-${side}`] as Dock[])
    .filter((d) => takesRoom(s, d)).map((d) => edgeSize(d, W, H, s.tuckSize) + GAP));
  return { l: col('left'), r: col('right') };
}

/** Center of a dock's drop target in stage coordinates (top/bottom: between the kept side columns at that end). */
function pinTargetCenter(edge: Dock, W: number, H: number, s: TuckState): { x: number; y: number } {
  const mid = (end: 'top' | 'bottom') => { const r = endRoom(s, W, H, end); return (W + r.l - r.r) / 2; };
  const C = 44; // corner targets sit in from both edges
  return {
    left: { x: 34, y: H / 2 }, right: { x: W - 34, y: H / 2 }, top: { x: mid('top'), y: 34 }, bottom: { x: mid('bottom'), y: H - 34 },
    'top-left': { x: C, y: C }, 'top-right': { x: W - C, y: C }, 'bottom-right': { x: W - C, y: H - C }, 'bottom-left': { x: C, y: H - C },
  }[edge];
}

type Inset = { l: number; r: number; t: number; b: number };

// Windows scrolled past in the nested view: invisible and, with visibility hidden, not painted, so
// they hold no GPU tiles (opacity alone still rasters them).
const HIDDEN: React.CSSProperties = { opacity: 0, visibility: 'hidden', pointerEvents: 'none' };

const ROWS = 3; // tile rows per column in the carousel
const RING = ROWS * 2; // tiles per side (two columns); farther windows slide off the edge

/**
 * The carousel, in an iw×ih box: window k (distance from the focus; negative = newer) sits in the
 * middle at k = 0; k = ±1..6 fill a 2-column × 3-row grid on the right (older) or left (newer), the
 * near column larger than the far one; farther windows wait just past the stage edge, hidden. When a
 * side has nothing to show (the newest window is focused, or the oldest), the middle window
 * stretches into it. Tiles carry a scale so they read as zoomed-out copies of the window rather
 * than a squashed layout, and grow smoothly into the middle.
 */
function carouselRect(k: number, iw: number, ih: number, hasNewer: boolean, hasOlder: boolean): { rect: Rect; scale: number; hidden: boolean } {
  const cw = iw * 0.56, ch = ih * 0.92;
  const cx = (iw - cw) / 2, cy = (ih - ch) / 2;
  if (k === 0) {
    const x0 = hasNewer ? cx : 0, x1 = hasOlder ? cx + cw : iw;
    return { rect: { x: x0, y: cy, w: x1 - x0, h: ch }, scale: 1, hidden: false };
  }
  const side = cx - GAP * 2; // room beside the middle window
  const d = Math.abs(k), right = k > 0;
  const nearW = side * 0.56, farW = side - nearW - GAP;
  const col = d <= ROWS ? 0 : 1, row = (d - 1) % ROWS;
  const w = d > RING ? farW * 0.8 : col === 0 ? nearW : farW;
  const h = w * (ch / cw); // same shape as the middle window
  const offset = col === 0 ? GAP * 2 : GAP * 3 + nearW; // from the middle window outward
  const y = ih / 2 - h / 2 + (row - (ROWS - 1) / 2) * (h + GAP); // rows centered on the middle
  const x = d > RING
    ? (right ? iw + GAP * 4 : -w - GAP * 4) // parked past the edge, ready to slide in
    : right ? cx + cw + offset : cx - offset - w;
  return { rect: { x, y, w, h }, scale: w / cw, hidden: d > RING };
}

/** Tile the desktops into the stage, minus room for any edge panels kept open. */
function place(pages: DesktopPage[], W: number, H: number, focus: number, ins: Inset, carousel = false): Placed[] {
  const out: Placed[] = [];
  const iw = W - PAD * 2 - ins.l - ins.r, ih = H - PAD * 2 - ins.t - ins.b;
  for (const p of pages) {
    if (p.layout === 'nested' && carousel) {
      const f = Math.min(focus, Math.max(0, p.windows.length - 1));
      p.windows.forEach((id, i) => {
        const k = i - f;
        const { rect, scale, hidden } = carouselRect(k, iw, ih, f > 0, f < p.windows.length - 1);
        out.push({ id, page: p.index, index: p.start + i, rect: { ...rect, x: p.index * W + PAD + ins.l + rect.x, y: PAD + ins.t + rect.y }, hidden, far: Math.abs(k) > RING + 2, scale });
      });
      continue;
    }
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
  const theme = useTheme(config.theme);
  const pages = useMemo(() => computeDesktops(state.order, desktopsFor(state.desktops, config.nestedView), config.defaultLayout),
    [state.order, state.desktops, config.defaultLayout, config.nestedView]);
  const [view, setViewRaw] = useState(0);
  // Top bar auto-hide: shown while the pointer is up there. Thin strips (above app frames, which
  // swallow the pointer) show it at the top edge and hide it just below it, so the bar itself can
  // stay a drag region (Electron gives drag regions no pointer events). The traffic lights hide
  // with it, so nothing sits under them.
  const [barShown, setBarShown] = useState(false);
  const barTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const showBar = (on: boolean) => { clearTimeout(barTimer.current); barTimer.current = setTimeout(() => setBarShown(on), on ? 0 : 250); };
  useEffect(() => { window.glass.windowButtons?.(!config.topBarAutoHide || barShown); }, [config.topBarAutoHide, barShown]);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [peek, setPeek] = useState<Dock | null>(null); // dock slid out (hover, or from the launcher)
  // Dragging a launcher icon: along the launcher reorders windows; onto a dock target docks it.
  const [dockDrag, setDockDrag] = useState<{ id: string; px: number; py: number; tuck: Dock | null; slot?: number | null; before: string | null } | null>(null);
  /**
   * Where a drag at (cx, cy) would dock: a hidden dock through its drop target (always shown while
   * dragging, and checked first so a corner's target works over a kept-open side dock); a dock kept
   * open takes drops anywhere over it; a hidden edge also takes its whole strip when `strips` (⌘
   * held, or a launcher icon drag).
   */
  const pinTarget = (cx: number, cy: number, strips: boolean, showing: Dock | null = null): Dock | null => {
    const st = stageRef.current?.getBoundingClientRect();
    if (!st || cx < st.left || cx > st.right || cy < st.top || cy > st.bottom) return null;
    // Open = kept open, or slid out right now (e.g. the dock a window is being dragged out of).
    const open = (e: Dock) => !!state.tucked?.[e]?.length && (!!state.tuckKeep?.includes(e) || e === showing);
    const x = cx - st.left, y = cy - st.top;
    for (const e of DOCKS) {
      if (open(e)) continue;
      const c = pinTargetCenter(e, st.width, st.height, state);
      if (Math.hypot(x - c.x, y - c.y) <= PIN_TARGET) return e;
    }
    for (const e of DOCKS) {
      if (!open(e)) continue;
      const r = panelRect(e, st.width, st.height, state);
      if (x >= r.x - GAP / 2 && x <= r.x + r.w + GAP / 2 && y >= r.y - GAP / 2 && y <= r.y + r.h + GAP / 2) return e;
    }
    if (!strips) return null;
    const hit: Edge | null = cx - st.left < TUCK_ZONE ? 'left' : st.right - cx < TUCK_ZONE ? 'right'
      : cy - st.top < TUCK_ZONE ? 'top' : st.bottom - cy < TUCK_ZONE ? 'bottom' : null;
    return hit && !open(hit) ? hit : null;
  };
  /** Where in an open dock a window dropped at (cx, cy) would go (its other windows keep order). */
  const panelIndexAt = (edge: Dock, cx: number, cy: number, dragId: string): number => {
    const st = stageRef.current!.getBoundingClientRect();
    const r = panelRect(edge, st.width, st.height, state);
    const others = (state.tucked?.[edge] ?? []).filter((x) => x !== dragId);
    const vertical = stacks(edge);
    const pos = vertical ? (cy - st.top - r.y) / r.h : (cx - st.left - r.x) / r.w;
    return Math.max(0, Math.min(others.length, Math.floor(pos * (others.length + 1))));
  };
  // Nested layout: which window is in the big pane (by id, so new windows don't move you; null = newest).
  const [focusId, setFocusId] = useState<string | null>(null);
  const nestedPage = pages.find((p) => p.layout === 'nested');
  // When the focused window goes (closed, docked), focus stays at its position, on the window that
  // took its place, instead of jumping back to the newest: closing neighbors one after another
  // walks along the row.
  const lastFocus = useRef(0);
  const at = nestedPage && focusId ? nestedPage.windows.indexOf(focusId) : 0;
  const focus = !nestedPage || !focusId ? 0 : at >= 0 ? at : Math.max(0, Math.min(lastFocus.current, nestedPage.windows.length - 1));
  useEffect(() => {
    lastFocus.current = focus;
    if (nestedPage && focusId && at < 0) setFocusId(focus === 0 ? null : nestedPage.windows[focus] ?? null);
  });
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
      if (e.key === 'Escape') selectWindow(null);
      if (!(e.ctrlKey || e.metaKey)) return;
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && pages[v]?.layout === 'nested') stepFocus(e.key === 'ArrowDown' ? 1 : -1);
      // Carousel: ⌘←/⌘→ move along the row (there are no desktops to switch).
      if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && pages[v]?.layout === 'nested' && config.nestedStyle === 'carousel') { stepFocus(e.key === 'ArrowRight' ? 1 : -1); return; }
      if (e.key === 'ArrowRight') setView(Math.min(v + 1, pages.length - 1));
      if (e.key === 'ArrowLeft') setView(v - 1);
    };
    let acc = 0, cool = 0;
    const onWheel = (e: WheelEvent) => {
      const target = e.target as HTMLElement;
      // Horizontal swipe anywhere; vertical scroll (mouse wheels) only outside windows, if enabled.
      const horizontal = Math.abs(e.deltaX) >= Math.abs(e.deltaY) * 1.5;
      // Nested view: scrolling outside the content (gaps, bars, title bars, shields) walks the
      // spiral, or in the carousel moves along the row (a sideways swipe works too).
      if (pages[v]?.layout === 'nested' && !target.closest?.('.body, .layout-menu, .question-card, .lightbox, .edge-panel')) {
        const now = Date.now();
        if (now < cool) return;
        acc += horizontal ? e.deltaX : e.deltaY;
        if (Math.abs(acc) > 60) { stepFocus(Math.sign(acc)); acc = 0; cool = now + 350; }
        return;
      }
      // A shielded (unselected) layout window counts as outside: scrolling over it walks desktops.
      const outside = !target.closest?.('.window, .layout-menu, .question-card, .lightbox') || !!target.closest?.('.strip .body-shield');
      const vertical = !horizontal && config.wheelDesktops && outside;
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
    // Clicking anywhere but the selected window deselects it (a shield's own handler then selects
    // the window clicked). Clicks inside a frame never reach here, so using a window keeps it selected.
    const onDown = (e: PointerEvent) => {
      const win = (e.target as HTMLElement).closest?.('.window') as HTMLElement | null;
      if (!win || win.dataset.window !== selectedId) selectWindow(null);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('wheel', onWheel, { passive: true });
    window.addEventListener('pointerdown', onDown, true);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('wheel', onWheel); window.removeEventListener('pointerdown', onDown, true); };
  }, [v, pages, setView, config.wheelDesktops, config.nestedStyle, focus]); // eslint-disable-line react-hooks/exhaustive-deps

  // Docks kept open take their space from the layout: side columns (edge and corner docks), then
  // top/bottom docks between them. Floating ones lie over it instead.
  const kept = state.tuckKeep ?? [];
  const floating = state.tuckFloat ?? [];
  const inset = useMemo(() => {
    const room = (e: Edge) => (takesRoom(state, e) ? edgeSize(e, size.W, size.H, state.tuckSize) + GAP : 0);
    const side = sideRoom(state, size.W, size.H);
    return { l: side.l, r: side.r, t: room('top'), b: room('bottom') };
  }, [size.W, size.H, kept.join(), floating.join(), state.tucked, state.tuckSize]); // eslint-disable-line react-hooks/exhaustive-deps
  const carousel = config.nestedStyle === 'carousel';
  const placed = useMemo(() => place(pages, size.W, size.H, focus, inset, carousel), [pages, size, focus, inset, carousel]);
  const opacityFor = (m: InstanceMeta) => m.opacity ?? state.settings.windowOpacity ?? config.windowOpacity;

  // ---- drag to reorder -------------------------------------------------------------
  const edgeTimer = useRef<number | null>(null);
  /** Start dragging a window by its title bar: one in the layout, or one in a dock (`from`). */
  const onDragStart = (id: string, e: React.PointerEvent, from?: Dock) => {
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

  // Launcher icon drags (started by the Launcher once the pointer moves a few px).
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
      if (b === undefined || state.settings.windowMode === 'history' || config.launcherOrder === 'fixed' || b === id) return;
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
  }, [dockDrag?.id, state.order, state.settings.windowMode, config.launcherOrder]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Bring a window into view without reordering: slide out its dock, go to its desktop, or (nested view) focus it. */
  function reveal(id: string) {
    const edge = DOCKS.find((e) => state.tucked?.[e]?.includes(id));
    if (edge) return setPeek(edge);
    const p = placed.find((x) => x.id === id);
    if (nestedPage?.windows.includes(id)) setFocusId(nestedPage.windows.indexOf(id) === 0 ? null : id);
    setView(p ? p.page : 0);
  }
  // Another app asked to show a window (Files → the change to a file); open it first if it's closed.
  const revealRef = useRef(reveal);
  revealRef.current = reveal;
  useEffect(() => {
    const on = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      const shown = state.order.includes(id) || DOCKS.some((d) => state.tucked?.[d]?.includes(id));
      if (shown) revealRef.current(id);
      else void dispatch({ type: 'window.open', id }).then(() => { setFocusId(null); setView(0); }); // it opens first
    };
    window.addEventListener('glass:reveal', on);
    return () => window.removeEventListener('glass:reveal', on);
  }, [state.order, state.tucked]);

  const s = state.session;
  const waiting = s.endedAt ? undefined : s.waiting;
  const presence = s.endedAt ? 'ended' : waiting ? 'waiting' : s.activity;
  const rel = (t: string) => (s.cwd ? t.split(s.cwd + '/').join('') : t);
  const glow = waiting && config.waitingGlow ? ' waiting-glow' : '';
  return (
    <ThemeContext.Provider value={theme}>
    <div className={`glass${config.launcherAutoHide ? ' dock-autohide' : ''}${config.topBarAutoHide ? ` topbar-autohide${barShown ? ' topbar-shown' : ''}` : ''}${state.tucked?.bottom?.length ? ' has-bottom-pin' : ''}${glow}`}
      style={{ ['--signal-gain' as any]: config.signalStrength === 'subtle' ? 0.6 : config.signalStrength === 'strong' ? 1.45 : 1 }}>
      <Wallpaper bg={config.background} animate={config.animateBackground} light={theme === 'light'} colors={lightColors({
        signal: state.settings.backgroundColors, stateColors: config.stateColors !== false,
        palettes: config.statePalettes ?? DEFAULT_PALETTES, mood: moodOf(state.session), own: config.backgroundColors ?? [],
      })} />
      <SignalLayer state={state} on={config.signals !== false} done={config.signalDone !== false} />
      {config.turnProgress !== false && <TurnBar state={state} />}
      {config.topBarAutoHide && <div className="topbar-hot" aria-hidden onMouseEnter={() => showBar(true)} />}
      {config.topBarAutoHide && barShown && <div className="topbar-leave" aria-hidden onMouseEnter={() => showBar(false)} />}
      <header className="topbar">
        <div className="session">
          <span className="project">{s.title}</span>
          {config.interruptButton === true && presence === 'working' ? <StopPresence /> : (
            <span className={`presence presence-${presence}`} title={waiting ? `${rel(waiting.summary)} (answer in Claude Code)` : undefined}>
              <i />
              {waiting ? 'Waiting on you' : presence === 'working' ? 'Claude is working' : presence === 'ended' ? 'Session ended' : 'Idle'}
              {waiting && <span className="presence-detail">{waiting.kind === 'permission' ? 'Permission' : 'Question'}: {rel(waiting.summary)}</span>}
            </span>
          )}
          {config.askBox === true && !s.endedAt && <AskBox />}
          {/* The background window has no title bar (the layout covers it): its controls live here. */}
          {state.backdrop && state.instances[state.backdrop] && (
            <span className="backdrop-chip" title="This window fills the glass behind everything">
              <AppIcon type={state.instances[state.backdrop].type} />{state.instances[state.backdrop].title} · background
              <button onClick={() => void dispatch({ type: 'window.backdrop', id: null })} title="Put it back into the layout">Back into the layout</button>
              <button aria-label="Close it" title="Close it" onClick={() => void dispatch({ type: 'window.close', id: state.backdrop! })}>×</button>
            </span>
          )}
          {(state.attachments ?? []).map((a) => (
            <span key={a.id} className="attach-chip" title={`Goes with your next prompt, as context Claude reads:\n\n${a.text.slice(0, 600)}`}>
              <i aria-hidden />{a.label}
              <button aria-label={`Don't attach ${a.label}`} onClick={() => void dispatch({ type: 'attach.remove', id: a.id })}>×</button>
            </span>
          ))}
        </div>
        {s.modMissing && !s.endedAt && (
          <span className="mod-missing" title="The Claude Glass mod isn't running in this Claude session, so the glass doesn't fill itself. It needs Claude Code 2.1.287 or newer with mods allowed; start a new session once that's fixed.">
            <i />Not connected: the glass mod isn't running in this session
          </span>
        )}
        <UpdatePill />
        <nav className="pager" aria-label="Desktops">
          {pages.map((p) => (
            <button key={p.index} className={p.index === v ? 'on' : ''} onClick={() => setView(p.index)} title={`Desktop ${p.index + 1}`} />
          ))}
        </nav>
        {config.contextGauge !== false && <ContextGauge usage={s.usage} />}
        <Version />
      </header>

      {/* Read-only, unless the Action app has the question to answer (the questions experiment). */}
      {waiting?.kind === 'question' && !(state.appState.action as { requests?: { kind: string; status: string }[] } | undefined)?.requests?.some((r) => r.kind === 'question' && r.status === 'pending')
        && <QuestionCard waiting={waiting} />}

      <main className={`stage${drag || dockDrag ? ' dragging-any' : ''}`} ref={stageRef}>
        <Backdrop W={size.W} H={size.H} />
        <div className="strip" style={{ transform: `translateX(${-v * size.W}px)` }}>
          {/* Stable DOM order (by id): windows are placed by transform, so a reorder never moves
              a node, and app frames never reload. */}
          {[...placed].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((p) => {
            const meta = state.instances[p.id];
            if (!meta) return null;
            const dragging = drag?.id === p.id;
            const style: React.CSSProperties = dragging
              ? { width: p.rect.w, height: p.rect.h, transform: `translate(${drag.px - (stageRef.current?.getBoundingClientRect().left ?? 0) - drag.ox + v * size.W}px, ${drag.py - (stageRef.current?.getBoundingClientRect().top ?? 0) - drag.oy}px) scale(.97)` }
              : p.scale
                // Watch view: laid out at the middle window's size and shrunk from its top-left
                // corner, so tiles read as zoomed-out copies and grow smoothly into the middle.
                ? { width: p.rect.w / p.scale, height: p.rect.h / p.scale, transformOrigin: '0 0', transform: `translate(${p.rect.x}px, ${p.rect.y}px) scale(${p.scale})`,
                    ...(p.hidden ? HIDDEN : {}) }
                : { width: p.rect.w, height: p.rect.h, transform: `translate(${p.rect.x}px, ${p.rect.y}px)`,
                    ...(p.hidden ? HIDDEN : {}) };
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
                onTileClick={p.scale && p.scale < 1 ? () => setFocusId(p.index === 0 ? null : p.id) : undefined}
              >
                {/* Virtualization: only windows near what's on screen mount their app view. */}
                {dragging || (!p.far && Math.abs(p.page - v) <= 1)
                  ? <AppBody id={p.id} meta={meta} w={p.rect.w / (p.scale ?? 1)} h={p.rect.h / (p.scale ?? 1)} />
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
          {nestedPage && !carousel && (() => {
            const newer = focus, older = Math.max(0, nestedPage.windows.length - focus - 6);
            const left = nestedPage.index * size.W;
            return (<>
              {newer > 0 && <button className="nest-badge top" style={{ left: left + size.W / 2 }} onClick={() => setFocusId(null)}>↑ {newer} newer</button>}
              {older > 0 && <span className="nest-badge bottom" style={{ left: left + size.W - 90 }}>{older} older ↓</span>}
            </>);
          })()}
          {pages.every((p) => p.windows.length === 0) && !DOCKS.some((e) => state.tucked?.[e]?.length)
            && !(state.backdrop && state.instances[state.backdrop]) && !state.freeOrder?.some((id) => state.instances[id]) && (
            <div className="empty" style={{ width: size.W }}>
              <p>Nothing on screen. Open an app from the launcher, or ask Claude to show you something.</p>
            </div>
          )}
        </div>
        {(drag?.mod || dockDrag) && EDGES.filter((e) => !(state.tuckKeep?.includes(e) && state.tucked?.[e]?.length) && e !== drag?.from)
          .map((e) => <div key={e} className={`tuck-zone ${e}${(drag ?? dockDrag)!.tuck === e ? ' on' : ''}`}><span>Dock</span></div>)}
        {/* Dock targets (edges and corners): drop a dragged window on one to dock it there; anywhere else is a normal drag. */}
        {(drag || dockDrag) && DOCKS.filter((e) => !keptOpen(state, e) && e !== drag?.from).map((e) => {
          const c = pinTargetCenter(e, size.W, size.H, state);
          return <div key={e} className={`pin-target ${e}${isCorner(e) ? ' corner' : ''}${(drag ?? dockDrag)!.tuck === e ? ' on' : ''}`} style={{ left: c.x, top: c.y }} title={`Dock ${e}`}>
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden><path d="M9.5 1.5l5 5-1.4.6-2.6 2.6.3 3.3-1.3 1.3-3-3-3.8 3.8H2v-.7l3.8-3.8-3-3 1.3-1.3 3.3.3 2.6-2.6z" /></svg>
          </div>;
        })}
        <EdgePanels W={size.W} H={size.H} peek={peek} setPeek={setPeek} onWindowDragStart={onDragStart}
          drag={drag ?? (dockDrag ? { id: dockDrag.id, px: dockDrag.px, py: dockDrag.py, ox: 0, oy: 0, tuck: dockDrag.tuck, slot: dockDrag.slot ?? null } : null)} />
        <FreeWindows W={size.W} H={size.H} />
        <Overlays W={size.W} H={size.H} stageRef={stageRef} />
      </main>

      {config.launcherAutoHide && <div className="dock-hot" aria-hidden />}
      {dockDrag && <div className="dock-ghost" style={{ left: dockDrag.px, top: dockDrag.py }}><span className={`tile tile-${state.instances[dockDrag.id]?.type}`}><AppIcon type={state.instances[dockDrag.id]?.type} /></span></div>}
      <Launcher pages={pages} viewing={v} width={size.W} dragging={dockDrag} onDragStart={(id, x, y) => setDockDrag({ id, px: x, py: y, tuck: null, before: null })} onReveal={reveal} />
    </div>
    </ThemeContext.Provider>
  );
}

function Wallpaper({ bg, colors, animate, light }: { bg: string; colors: string[]; animate: boolean; light: boolean }) {
  const key = colors.join(',');
  const w = useMemo(() => wallpaper(bg, colors, light), [bg, key, light]); // eslint-disable-line react-hooks/exhaustive-deps
  const canvas = useRef<HTMLCanvasElement>(null);
  const painter = useRef<LightPainter | null>(null);
  useEffect(() => { painter.current = paintLights(canvas.current!); return () => painter.current?.stop(); }, []);
  useEffect(() => { painter.current?.set(w.blobs, animate); }, [w, animate]);
  return (
    <div className={`wallpaper${animate ? ' drifting' : ''}`} style={w.style} aria-hidden>
      <canvas ref={canvas} className="wallpaper-light" />
    </div>
  );
}

/**
 * How full Claude's context window is (contextGauge): a small ring and a percent, quiet until it's
 * nearly full. Hover for tokens, cost and plan limits.
 */
function ContextGauge({ usage }: { usage?: SessionUsage }) {
  const c = usage?.context;
  if (!c || !c.window) return null;
  const pct = Math.max(0, Math.min(100, Math.round(c.percent || (c.tokens / c.window) * 100)));
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n));
  const limits = (usage.rateLimits ?? []).map((r) => `${r.kind.replace(/_/g, ' ')} limit ${Math.round(r.percentUsed)}%`);
  const title = [`Context ${k(c.tokens)} / ${k(c.window)} tokens (${pct}%)`, usage.cost ? `Cost $${usage.cost.usd.toFixed(2)}` : '', ...limits].filter(Boolean).join('\n');
  const r = 6, len = 2 * Math.PI * r;
  return (
    <span className={`ctx-gauge${pct >= 85 ? ' full' : ''}`} title={title} aria-label={`Context ${pct}% full`}>
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
        <circle cx="8" cy="8" r={r} className="track" />
        <circle cx="8" cy="8" r={r} className="arc" strokeDasharray={`${(pct / 100) * len} ${len}`} transform="rotate(-90 8 8)" />
      </svg>
      {pct}%
    </span>
  );
}

/** Ask Claude from the header (askBox, two-way; Conversation always has its own box): sent as your prompt, once Claude is free. */
function AskBox() {
  const [text, setText] = useState('');
  const [sent, setSent] = useState(false);
  return (
    <form className="ask-box" onSubmit={(e) => { e.preventDefault(); if (!text.trim()) return; window.glass.submitPrompt(text, 'header'); setText(''); setSent(true); setTimeout(() => setSent(false), 2500); }}>
      <input value={text} onChange={(e) => setText(e.target.value)} placeholder={sent ? 'Sent to Claude' : 'Ask Claude…'} aria-label="Ask Claude (sent as your prompt)" />
    </form>
  );
}

/** Working, with Stop on (interruptButton, two-way): hovering the pill turns its dot into a stop
 *  square; a click ends Claude's turn, like Esc in Claude Code. */
function StopPresence() {
  const [sent, setSent] = useState(false);
  return (
    <button className="presence presence-working stoppable" disabled={sent} title="Stop Claude (like Esc in Claude Code)"
      onClick={() => { setSent(true); window.glass.interrupt(); setTimeout(() => setSent(false), 4000); }}>
      <i />{sent ? 'Stopping…' : 'Claude is working'}
    </button>
  );
}

/** The version this glass runs, muted in the corner (dev when it's run from a checkout). */
function Version() {
  const [v, setV] = useState<{ version: string; dev: boolean } | null>(null);
  useEffect(() => { void window.glass.version?.().then(setV); }, []);
  if (!v) return null;
  return <span className="version" title={v.dev ? 'Running from a checkout' : 'Installed plugin version'}>{v.version}{v.dev ? ' dev' : ''}</span>;
}

/** A newer Claude Glass is installed: a pill in the top bar restarts this glass in it. */
function UpdatePill() {
  const [u, setU] = useState<{ version: string } | null>(null);
  const [going, setGoing] = useState(false);
  useEffect(() => { void window.glass.getUpdate?.().then(setU); return window.glass.onUpdate?.(setU); }, []);
  if (!u) return null;
  return (
    <button className="update-pill" disabled={going} title="Restart this glass in the new version (your windows and history stay)"
      onClick={() => { setGoing(true); window.glass.applyUpdate(); }}>
      <i />{going ? 'Restarting…' : <>Claude Glass {u.version} is ready <b>Restart</b></>}
    </button>
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

/** The window filling the whole glass behind everything (window.backdrop): the layout sits on it. */
function Backdrop({ W, H }: { W: number; H: number }) {
  const { state, config } = useSnapshot();
  const id = state.backdrop;
  const meta = id ? state.instances[id] : undefined;
  if (!id || !meta) return null;
  return (
    <div className="backdrop-layer">
      <WindowFrame meta={meta} style={{ width: W, height: H }} dragging={false} dropTarget={false} placement="backdrop"
        opacity={meta.opacity ?? state.settings.windowOpacity ?? config.windowOpacity}>
        <AppBody id={id} meta={meta} w={W} h={H + 36} />{/* no title bar to leave room for */}
      </WindowFrame>
    </div>
  );
}

/**
 * Free windows (window.free): wherever the user put them, over the tiled layout and under the
 * docks. Drag one by its title bar, resize it from its corner; a press anywhere on it raises it.
 * While it moves the place is local; letting go saves it (window.place).
 */
function FreeWindows({ W, H }: { W: number; H: number }) {
  const { state, config } = useSnapshot();
  const [live, setLive] = useState<{ id: string; rect: FreeRect } | null>(null);
  const ids = (state.freeOrder ?? []).filter((id) => state.instances[id] && state.free?.[id]);
  if (!ids.length) return null;
  /** Follow the pointer from a press: move (title bar) or resize (corner), in fractions of the glass. */
  const track = (id: string, e: React.PointerEvent, mode: 'move' | 'size') => {
    const start = state.free![id];
    const x0 = e.clientX, y0 = e.clientY;
    let rect = start;
    document.body.classList.add('frames-off'); // app frames under the pointer would swallow it
    const onMove = (ev: PointerEvent) => {
      const dx = (ev.clientX - x0) / W, dy = (ev.clientY - y0) / H;
      rect = mode === 'move'
        ? { ...start, x: Math.min(0.95, Math.max(-start.w + 0.05, start.x + dx)), y: Math.min(0.95, Math.max(0, start.y + dy)) }
        : { ...start, w: Math.max(0.08, start.w + dx), h: Math.max(0.08, start.h + dy) };
      setLive({ id, rect });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.classList.remove('frames-off');
      if (rect !== start) void dispatch({ type: 'window.place', id, rect }).finally(() => setLive(null));
      else setLive(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };
  return (
    <div className="free-layer">
      {ids.map((id, z) => {
        const meta = state.instances[id];
        const r = live?.id === id ? live.rect : state.free![id];
        const w = r.w * W, h = r.h * H;
        return (
          <div key={id} className={`free-slot${live?.id === id ? ' moving' : ''}`} style={{ zIndex: z + 1 }}
            onPointerDownCapture={() => { if (z !== ids.length - 1) void dispatch({ type: 'window.raise', id }); }}>
            <WindowFrame meta={meta} style={{ width: w, height: h, transform: `translate(${r.x * W}px, ${r.y * H}px)` }} dragging={live?.id === id}
              dropTarget={false} placement="free" opacity={meta.opacity ?? state.settings.windowOpacity ?? config.windowOpacity}
              onDragStart={(e) => track(id, e, 'move')}>
              <AppBody id={id} meta={meta} w={w} h={h} />
              <div className="free-resize" title="Drag to resize" onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); track(id, e, 'size'); }} />
            </WindowFrame>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Overlay apps' windows: each over the whole glass, above every window and dock, transparent and
 * click-through but where its view asks (FrameView). They get where the windows are, measured from
 * the screen (so moves, docks sliding out and animations count), while one is open.
 */
function Overlays({ W, H, stageRef }: { W: number; H: number; stageRef: React.RefObject<HTMLDivElement | null> }) {
  const { state, config } = useSnapshot();
  const ids = (state.overlays ?? []).filter((id) => state.instances[id] && apps[state.instances[id].type]?.frame);
  const [layout, setLayout] = useState<import('../sdk/glass-app').OverlayWindow[]>([]);
  const orderKey = state.order.join();
  useEffect(() => {
    if (!ids.length) return;
    let last = '';
    const measure = () => {
      const st = stageRef.current?.getBoundingClientRect();
      if (!st) return;
      const out: import('../sdk/glass-app').OverlayWindow[] = [];
      for (const el of document.querySelectorAll<HTMLElement>('.window[data-window]')) {
        const id = el.dataset.window!;
        const meta = state.instances[id];
        if (!meta || ids.includes(id)) continue;
        const r = el.getBoundingClientRect();
        // On screen: inside the stage and actually showing (not a parked desktop or a hidden dock).
        if (r.width < 8 || r.height < 8 || r.right <= st.left || r.left >= st.right || r.bottom <= st.top || r.top >= st.bottom) continue;
        if (getComputedStyle(el).visibility === 'hidden' || Number(getComputedStyle(el.closest('.edge-panel') ?? el).opacity) < 0.5) continue;
        const dock = el.closest('.edge-panel') ? DOCKS.find((d) => state.tucked?.[d]?.includes(id)) : undefined;
        out.push({ id, type: meta.type, title: meta.title, x: Math.round(r.left - st.left), y: Math.round(r.top - st.top), w: Math.round(r.width), h: Math.round(r.height),
          rank: dock ? -1 : state.order.indexOf(id), ...(dock ? { dock } : {}) });
      }
      const key = JSON.stringify(out);
      if (key !== last) { last = key; setLayout(out); }
    };
    measure();
    const t = setInterval(measure, 200);
    return () => clearInterval(t);
  }, [ids.join(), orderKey, state.tucked, state.instances, W, H]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!ids.length) return null;
  return (
    <div className="overlay-layer">
      {[...ids].reverse().map((id) => {
        const meta = state.instances[id];
        const app = apps[meta.type]!;
        const run = (command: string, args: Record<string, unknown> = {}) => dispatch({ type: 'app.command', id, command, args });
        return (
          <div key={id} className="overlay-app" data-overlay={id}>
            <FrameView app={app} id={id} meta={meta} state={state.appState[id] ?? null} width={W} height={H} glass={state} run={run}
              savedSettings={config.appSettings?.[meta.type]} layout={layout} />
          </div>
        );
      })}
    </div>
  );
}

function AppBody({ id, meta, w, h }: { id: string; meta: InstanceMeta; w: number; h: number }) {
  const { state, config } = useSnapshot();
  const app = apps[meta.type];
  const View = app?.frame ? null : VIEWS[meta.type];
  const appState = state.appState[id] ?? null;
  const run = useCallback((command: string, args: Record<string, unknown> = {}) => dispatch({ type: 'app.command', id, command, args }), [id]);
  if (app?.frame) return <FrameView app={app} id={id} meta={meta} state={appState} width={w} height={h - 36} glass={state} run={run} savedSettings={config.appSettings?.[meta.type]} />;
  if (!View) return <div className="app-missing">No view for “{meta.type}”.</div>;
  return <View id={id} meta={meta} state={appState} width={w} height={h - 36} run={run} glass={state} config={config} />;
}

// Select to interact: which window takes clicks and scrolling. The rest are shielded, so the wheel
// anywhere over them walks desktops (or the spiral) instead of scrolling their content. View-only UI
// state (like a hover), not glass state: it never reaches the reducer.
let selectedId: string | null = null;
const selectListeners = new Set<() => void>();
function selectWindow(id: string | null) {
  if (selectedId === id) return;
  selectedId = id;
  for (const fn of selectListeners) fn();
}
const useSelected = () => useSyncExternalStore((fn) => { selectListeners.add(fn); return () => { selectListeners.delete(fn); }; }, () => selectedId);

function WindowFrame(props: {
  meta: InstanceMeta; style: React.CSSProperties; dragging: boolean; dropTarget: boolean; opacity: number;
  page?: DesktopPage; onDragStart?: (e: React.PointerEvent) => void; children: React.ReactNode; tucked?: Dock;
  onTileClick?: () => void; // carousel side tile: a click brings it to the middle instead of selecting
  placement?: 'free' | 'backdrop'; // a free window, or the one filling the background
}) {
  const { meta, page, tucked, placement } = props;
  const [menu, setMenu] = useState(false);
  const app = apps[meta.type];
  const { state, config } = useSnapshot();
  const history = state.settings.windowMode === 'history';
  const selected = useSelected() === meta.id;
  // Sidebar windows stay live: they aren't part of scrolling through desktops.
  // Free windows and the background stay live too: the user put them there to use them.
  const shielded = config.selectToInteract !== false && !selected && !tucked && !placement;
  const place = (a: Action) => { void dispatch(a); setMenu(false); };
  return (
    <section
      className={`window${props.dragging ? ' dragging' : ''}${props.dropTarget ? ' drop-target' : ''}${selected && config.selectToInteract !== false ? ' selected' : ''}${placement ? ` ${placement}` : ''}`}
      style={{ ...props.style, ['--glass' as any]: props.opacity }}
      data-window={meta.id}
    >
      {/* The background window has no title bar: the layout would cover it (the top bar has its controls). */}
      {placement !== 'backdrop' && <div className="titlebar" onPointerDown={(e) => { if (!props.onDragStart || (e.target as HTMLElement).closest('button')) return; e.preventDefault(); props.onDragStart(e); }}>
        <div className="lights">
          <button className="light close" title="Close window" aria-label="Close window" onClick={() => dispatch({ type: 'window.close', id: meta.id })} />
          {!history && !tucked && !placement && <button className="light front" title="Move to first slot" aria-label="Move to first slot" onClick={() => dispatch({ type: 'window.move', id: meta.id, index: 0 })} />}
          <button className="light layout" title={page && page.layout !== 'nested' ? 'Layout and placement' : 'Placement'} aria-label="Layout and placement" onClick={() => setMenu((m) => !m)} />
        </div>
        <span className="wtitle" title={`${meta.title} · id: ${meta.id}`}><em><AppIcon type={meta.type} /></em>{meta.title}</span>
        {menu && (
          <div className="layout-menu" onMouseLeave={() => setMenu(false)}>
            {page && page.layout !== 'nested' && LAYOUT_NAMES.map((l) => (
              <button key={l} className={l === page.layout ? 'on' : ''} onClick={() => { dispatch({ type: 'desktop.layout', desktop: page.index, layout: l }); setMenu(false); }}>
                <LayoutGlyph name={l} />
                {LAYOUTS[l].label}
              </button>
            ))}
            {/* Where this window lives: the layout, free anywhere, or filling the background. */}
            {page && page.layout !== 'nested' && <hr />}
            {placement !== 'free' && <button onClick={() => place({ type: 'window.free', id: meta.id })}><PlaceGlyph kind="free" />Free window</button>}
            <button onClick={() => place({ type: 'window.backdrop', id: meta.id })}><PlaceGlyph kind="backdrop" />Fill the background</button>
            {(placement || tucked) && <button onClick={() => place({ type: 'window.untuck', id: meta.id })}><PlaceGlyph kind="tile" />Back into the layout</button>}
          </div>
        )}
      </div>}
      <div className="body">{props.children}</div>
      {props.onTileClick
        ? <div className="body-shield" title="Bring to the middle" onPointerDown={props.onTileClick} />
        : shielded && <div className="body-shield" title="Click to use this window" onPointerDown={() => selectWindow(meta.id)} />}
    </section>
  );
}

/** The placement options' glyphs, drawn like the layout ones. */
function PlaceGlyph({ kind }: { kind: 'free' | 'backdrop' | 'tile' }) {
  return (
    <svg viewBox="0 0 30 20" width="30" height="20" aria-hidden>
      {kind === 'free' && <><rect x="2" y="3" width="15" height="10" rx="2" opacity=".45" /><rect x="11" y="7" width="16" height="11" rx="2" /></>}
      {kind === 'backdrop' && <><rect x="1" y="1" width="28" height="18" rx="2" opacity=".45" /><rect x="6" y="5" width="18" height="10" rx="2" /></>}
      {kind === 'tile' && <><rect x="1" y="1" width="13" height="18" rx="2" /><rect x="16" y="1" width="13" height="8" rx="2" /><rect x="16" y="11" width="13" height="8" rx="2" /></>}
    </svg>
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

/**
 * The launcher: the bar along the bottom with an icon per window (and Settings). With grouping on,
 * an app's windows share one icon with a count, and clicking it lists them to pick one.
 */
function Launcher({ pages, viewing, onReveal, onDragStart, dragging, width }: {
  pages: DesktopPage[]; viewing: number; onReveal: (id: string) => void; width: number;
  onDragStart: (id: string, x: number, y: number) => void; dragging: { id: string } | null;
}) {
  const { state, config } = useSnapshot();
  // The open group menu: which app, and where its icon is (the menu sits above it).
  const [menu, setMenu] = useState<{ type: string; x: number; y: number } | null>(null);
  useEffect(() => {
    if (!menu) return;
    const down = (e: PointerEvent) => { if (!(e.target as HTMLElement).closest?.('.launcher-menu, .dock-item.group')) setMenu(null); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('pointerdown', down, true); window.removeEventListener('keydown', key); };
  }, [menu]);
  // Press + move a few px = drag (reorder along the launcher, or onto a dock); else a click.
  const press = useRef<{ id: string; x: number; y: number; started: boolean } | null>(null);
  const onPointerDown = (id: string, e: React.PointerEvent) => {
    press.current = { id, x: e.clientX, y: e.clientY, started: false };
    const move = (ev: PointerEvent) => {
      const p = press.current;
      if (!p || p.started || Math.hypot(ev.clientX - p.x, ev.clientY - p.y) < 6) return;
      p.started = true;
      setMenu(null);
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
  const docked = (id: string) => DOCKS.find((d) => state.tucked?.[d]?.includes(id));
  // The launcher holds what's open (on a desktop or docked); closed windows and apps not started
  // yet live in the Apps dialog, so the bar stays short as apps pile up.
  const items = Object.values(state.instances).filter((m) => m.type !== 'settings' && !off.has(m.type) && (open.has(m.id) || !!docked(m.id)))
    .sort(config.launcherOrder === 'fixed' ? fixed : byWindows);
  const [appsAt, setAppsAt] = useState<number | null>(null); // the Apps menu, open above its button (x)
  const appsOpen = appsAt != null;
  // Grouping: one entry per app, at its first window's place, holding all of its windows.
  const entries: InstanceMeta[][] = [];
  if (config.launcherGroup !== false) {
    const byType = new Map<string, InstanceMeta[]>();
    for (const m of items) {
      const g = byType.get(m.type);
      if (g) g.push(m); else { const list = [m]; byType.set(m.type, list); entries.push(list); }
    }
  } else for (const m of items) entries.push([m]);
  const show = (id: string) => (open.has(id) ? onReveal(id) : dispatch({ type: 'window.open', id }).then(() => onReveal(id)));
  const where = (id: string) => {
    const d = docked(id);
    if (d) return `docked ${d}`;
    if (!pageOf.has(id)) return 'closed';
    return pages.length > 1 ? `desktop ${pageOf.get(id)! + 1}` : 'open';
  };
  const settingsOpen = open.has('settings');
  // Crowded launcher: icons shrink to fit the window (38px → 26px); past that it scrolls. Counts
  // the system corner (Apps, Settings) and the separators between desktops.
  const seps = config.launcherOrder === 'fixed' ? 0 : entries.filter((g, i) => i > 0 && group(entries[i - 1][0].id) !== group(g[0].id)).length;
  const slots = entries.length + 2, extra = seps * 8 + 90;
  const tileSize = Math.max(26, Math.min(38, Math.floor((width - extra) / slots - 5)));
  const crowded = slots * (tileSize + 5) + extra > width;
  const menuItems = menu ? entries.find((g) => g[0].type === menu.type && g.length > 1) : undefined;
  return (
    <footer className="dock-wrap">
      {/* Class names say "dock" for history: this is the launcher. */}
      <div className={`dock${crowded ? ' crowded' : ''}${dragging ? ' dragging' : ''}`} style={{ ['--tile' as any]: `${tileSize}px` }}>
        {entries.map((g, i) => {
          const m = g[0];
          const sep = config.launcherOrder !== 'fixed' && i > 0 && group(entries[i - 1][0].id) !== group(m.id) && <span className="dock-sep screen" />;
          const tile = <span className={`tile tile-${m.type}${iconSrc(m.type) ? ' has-img' : ''}`}><AppIcon type={m.type} /></span>;
          if (g.length === 1) return (
            <Fragment key={m.id}>
              {sep}
              <button className={`dock-item${offScreen(m.id) ? ' off-screen' : ''}${dragging?.id === m.id ? ' lifted' : ''}`} title={m.title} data-dock-id={m.id}
                onPointerDown={(e) => onPointerDown(m.id, e)} onClick={clickable(() => show(m.id))}>
                {tile}
                <span className="label">{m.title}</span>
                {open.has(m.id) && <i className="running" />}
              </button>
            </Fragment>
          );
          // A group: dimmed when none of its windows is on this desktop; the menu picks one.
          const anyOpen = g.some((x) => open.has(x.id));
          const away = anyOpen && g.every((x) => !open.has(x.id) || offScreen(x.id));
          const title = apps[m.type]?.title ?? m.type;
          return (
            <Fragment key={`group-${m.type}`}>
              {sep}
              <button className={`dock-item group${away ? ' off-screen' : ''}${menu?.type === m.type ? ' menu-open' : ''}`} title={`${title}: ${g.length} windows`}
                data-dock-group={m.type} aria-haspopup="menu" aria-expanded={menu?.type === m.type}
                onClick={(e) => {
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  setMenu((cur) => (cur?.type === m.type ? null : { type: m.type, x: r.left + r.width / 2, y: r.top }));
                }}>
                {tile}
                <b className="count">{g.length}</b>
                <span className="label">{title}</span>
                {anyOpen && <i className="running" />}
              </button>
            </Fragment>
          );
        })}
        <span className="dock-sep" />
        {/* The system corner, always here: every closed or unopened app, and Settings. */}
        <button className={`dock-item sys${appsOpen ? ' menu-open' : ''}`} title="Apps" aria-haspopup="menu" aria-expanded={appsOpen} data-apps
          onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setAppsAt((cur) => (cur != null ? null : r.left + r.width / 2)); }}>
          <span className="tile tile-apps"><svg viewBox="0 0 20 20" width="17" height="17" aria-hidden><g fill="currentColor"><rect x="3" y="3" width="5.5" height="5.5" rx="1.6" /><rect x="11.5" y="3" width="5.5" height="5.5" rx="1.6" /><rect x="3" y="11.5" width="5.5" height="5.5" rx="1.6" /><rect x="11.5" y="11.5" width="5.5" height="5.5" rx="1.6" /></g></svg></span>
          <span className="label">Apps</span>
        </button>
        <button className={`dock-item${offScreen('settings') ? ' off-screen' : ''}`} title="Settings"
          onClick={() => (settingsOpen ? onReveal('settings') : dispatch({ type: 'instance.create', appType: 'settings' }).then(() => onReveal('settings')))}>
          <span className="tile tile-settings has-img"><AppIcon type="settings" /></span>
          <span className="label">Settings</span>
          {settingsOpen && <i className="running" />}
        </button>
      </div>
      {appsAt != null && <AppsMenu x={appsAt} onClose={() => setAppsAt(null)} onShown={(id) => { setAppsAt(null); onReveal(id); }} />}
      {menuItems && menu && (
        <div className="launcher-menu" role="menu" style={{ left: menu.x, bottom: window.innerHeight - menu.y + 10 }}>
          {menuItems.map((m) => (
            <button key={m.id} role="menuitem" className={`${open.has(m.id) && !offScreen(m.id) ? 'here' : ''}${dragging?.id === m.id ? ' lifted' : ''}`} data-dock-id={m.id}
              onPointerDown={(e) => onPointerDown(m.id, e)} onClick={clickable(() => { setMenu(null); void show(m.id); })}>
              <span className="lm-title">{m.title}</span>
              <span className="lm-where">{where(m.id)}</span>
            </button>
          ))}
        </div>
      )}
    </footer>
  );
}

/**
 * Apps (the launcher's system corner): every app that isn't on screen, or has windows closed. An
 * app with closed windows carries a count; hovering it lists them to reopen, and a click reopens the
 * latest, so nothing opens empty by accident. An app with none starts on a click.
 */
function AppsMenu({ x, onClose, onShown }: { x: number; onClose: () => void; onShown: (id: string) => void }) {
  const { state, config } = useSnapshot();
  const [hover, setHover] = useState<string | null>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const down = (e: PointerEvent) => { if (!(e.target as HTMLElement).closest?.('.apps-menu, [data-apps]')) onClose(); };
    window.addEventListener('keydown', key);
    window.addEventListener('pointerdown', down, true);
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('pointerdown', down, true); };
  }, [onClose]);
  const off = new Set(config.disabledApps ?? []);
  const shown = (id: string) => state.order.includes(id) || DOCKS.some((d) => state.tucked?.[d]?.includes(id));
  const all = Object.values(state.instances).filter((m) => m.type !== 'settings' && !off.has(m.type));
  const list = Object.values(apps).filter((a) => a.type !== 'settings' && !off.has(a.type)).map((a) => {
    const mine = all.filter((m) => m.type === a.type);
    const closed = mine.filter((m) => !shown(m.id)).sort((p, q) => q.createdAt - p.createdAt);
    const onScreen = mine.length - closed.length;
    return { a, closed, onScreen };
  }).filter(({ a, closed, onScreen }) => closed.length > 0 || (onScreen === 0 && !(a.singleton && all.some((m) => m.type === a.type))))
    .sort((p, q) => p.a.title.localeCompare(q.a.title));
  const reopen = (id: string) => void dispatch({ type: 'window.open', id }).then(() => onShown(id));
  const start = (type: string) => void dispatch({ type: 'instance.create', appType: type }).then((id) => { if (typeof id === 'string') onShown(id); });
  const pick = list.find((l) => l.a.type === hover && l.closed.length > 0);
  // A portal to <body>: inside the launcher it would inherit its pointer-events: none, and an
  // auto-hidden launcher's transform would move "fixed" with it.
  return createPortal(
    <div className="apps-menu" role="menu" aria-label="Apps" style={{ left: x }} onMouseLeave={() => setHover(null)}>
      {list.length === 0 && <p className="apps-none">Every app is open.</p>}
      <div className="apps-grid">
        {list.map(({ a, closed }) => (
          <button key={a.type} role="menuitem" className={`apps-tile${hover === a.type ? ' on' : ''}`} data-app={a.type}
            title={closed.length ? `${a.title}: reopen ${closed[0].title}` : `Start ${a.title}`}
            onMouseEnter={() => setHover(a.type)} onFocus={() => setHover(a.type)}
            onClick={() => (closed.length ? reopen(closed[0].id) : start(a.type))}>
            <span className="apps-icon big"><AppIcon type={a.type} />{closed.length > 1 && <b className="count">{closed.length}</b>}</span>
            <span className="apps-name">{a.title}</span>
          </button>
        ))}
      </div>
      {/* The hovered app's closed windows: pick one to reopen (or start a new one). */}
      {pick && (
        <div className="apps-sub" role="menu" aria-label={`${pick.a.title} windows`}>
          <h4>{pick.a.title}</h4>
          {pick.closed.map((m) => (
            <button key={m.id} role="menuitem" className="apps-row" onClick={() => reopen(m.id)}>
              <span className="apps-name">{m.title}</span><small>{ago(m.createdAt)}</small>
            </button>
          ))}
          {!pick.a.singleton && <button role="menuitem" className="apps-row new" onClick={() => start(pick.a.type)}><span className="apps-name">New {pick.a.title} window</span></button>}
        </div>
      )}
    </div>,
    document.body,
  );
}
const ago = (t: number) => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`; };

/**
 * Docks ("tucked" in state): windows docked at an edge or a corner leave the tiling flow and live
 * here, the same on every desktop. Hidden, a dock is a slim tab and hovering its edge (or corner)
 * starts pulling it out; a click opens it, or the hover does with `dockOpen: hover`. Kept open, the
 * layout makes room and its inner side drags to resize (a corner resizes both ways). Windows split
 * a dock evenly and stay mounted while hidden (a voice app keeps listening).
 */
function EdgePanels({ W, H, peek, setPeek, drag, onWindowDragStart }: {
  W: number; H: number; peek: Dock | null; setPeek: (e: Dock | null) => void;
  drag: Pick<Drag, 'id' | 'px' | 'py' | 'ox' | 'oy' | 'from' | 'tuck' | 'slot'> | null;
  onWindowDragStart: (id: string, e: React.PointerEvent, from: Dock) => void;
}) {
  const { state, config } = useSnapshot();
  const closeTimer = useRef<number | null>(null);
  const hold = (e: Dock) => { if (closeTimer.current) clearTimeout(closeTimer.current); closeTimer.current = null; setPeek(e); };
  // Pointer near a dock's pull (hovering the edge or its capsule): starts the pull-out animation
  // (or opens it, in hover mode), and keeps an open dock open (it slides in under the pointer,
  // which would otherwise count as leaving it and close it again).
  const [near, setNear] = useState<Dock | null>(null);
  const hoverOpens = config.dockOpen === 'hover';
  const enterPull = (e: Dock) => { setNear(e); if (hoverOpens) hold(e); else if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; } };
  const release = () => { closeTimer.current = window.setTimeout(() => { closeTimer.current = null; setPeek(null); }, 350); };
  // Leaving through an app frame sends the shell no mouseleave, so once the pointer has been in the
  // open dock, any move over the shell outside it (and its pull) lets it go too. (A dock opened from
  // the launcher waits for the pointer to arrive first.)
  // The other way round too: passing through a frame can fire a stray mouseleave, so a move over an
  // open dock holds it (and cancels a close that's pending).
  const visited = useRef(false);
  useEffect(() => { visited.current = false; }, [peek]);
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      const over = (d: Dock) => !!t.closest?.(`.edge-panel.${d}, .edge-cap.${d}, .edge-hot.${d}`);
      const panel = t.closest?.('.edge-panel.open') as HTMLElement | null;
      const inside = panel ? DOCKS.find((d) => panel.classList.contains(d)) : undefined;
      if (inside && !drag && (inside !== peek || closeTimer.current != null)) { hold(inside); visited.current = true; return; }
      if (near && !over(near)) setNear(null);
      if (peek && over(peek)) visited.current = true;
      else if (peek && visited.current && closeTimer.current == null && !drag) { visited.current = false; release(); }
    };
    window.addEventListener('pointermove', move);
    return () => window.removeEventListener('pointermove', move);
  }, [peek, near, drag]); // eslint-disable-line react-hooks/exhaustive-deps
  // Live size while dragging a dock's inner side (or a corner dock's inner corner); committed to
  // state on release. `axes`: which of width/height the handle changes.
  const [resizing, setResizing] = useState<{ edge: Dock; size: number; height?: number } | null>(null);
  const startResize = (edge: Dock, axes: 'w' | 'h' | 'wh', e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); // frames under the pointer would swallow the drag
    const stage = (e.currentTarget as HTMLElement).closest('.stage')!.getBoundingClientRect();
    const dist = (side: Edge, x: number, y: number) => ({ left: x - stage.left, right: stage.right - x, top: y - stage.top, bottom: stage.bottom - y }[side] - PAD);
    const corner = isCorner(edge) ? edge : null;
    const [vSide, hSide] = corner ? cornerSides(corner) : [edge as Edge, edge as Edge];
    let size = edgeSize(edge, W, H, state.tuckSize);
    let height = corner ? cornerHeight(corner, H, state.tuckHeight) : undefined;
    document.body.classList.add('frames-off');
    // An edge dock has one size (width at the sides, height at top/bottom); a corner has both.
    const move = (ev: PointerEvent) => {
      if (!corner) size = edgeSize(edge, W, H, { [edge]: dist(edge as Edge, ev.clientX, ev.clientY) });
      else {
        if (axes !== 'h') size = edgeSize(edge, W, H, { [edge]: dist(hSide, ev.clientX, ev.clientY) });
        if (axes !== 'w') height = cornerHeight(corner, H, { [corner]: dist(vSide, ev.clientX, ev.clientY) });
      }
      setResizing({ edge, size, height });
    };
    const up = () => {
      document.body.classList.remove('frames-off');
      window.removeEventListener('pointermove', move); setResizing(null);
      void dispatch(corner
        ? { type: 'tuck.size', edge, size: axes !== 'h' ? size : undefined, height: axes !== 'w' ? height : undefined }
        : { type: 'tuck.size', edge, size });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  };
  // Live shares while dragging the gap between two windows in a dock; committed on release.
  const [splitting, setSplitting] = useState<{ edge: Dock; shares: number[] } | null>(null);
  const startSplit = (edge: Dock, i: number, start: number[], r: Rect, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    const vertical = stacks(edge);
    const room = (vertical ? r.h : r.w) - GAP * (start.length - 1);
    const from = vertical ? e.clientY : e.clientX;
    let shares = start;
    document.body.classList.add('frames-off');
    const move = (ev: PointerEvent) => {
      // Move the boundary between window i and i+1; each keeps at least SPLIT_MIN.
      const pair = start[i] + start[i + 1];
      const min = Math.min(SPLIT_MIN / room, pair / 2);
      const a = Math.max(min, Math.min(pair - min, start[i] + ((vertical ? ev.clientY : ev.clientX) - from) / room));
      shares = start.map((x, j) => (j === i ? a : j === i + 1 ? pair - a : x));
      setSplitting({ edge, shares });
    };
    const up = () => {
      document.body.classList.remove('frames-off');
      window.removeEventListener('pointermove', move);
      setSplitting(null);
      if (shares !== start) void dispatch({ type: 'tuck.split', edge, shares });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  };
  // While a dock is being resized, every dock is placed from its live size, so neighbors (and the
  // fillets between them) follow the drag.
  const live: TuckState = resizing
    ? { ...state, tuckSize: { ...state.tuckSize, [resizing.edge]: resizing.size }, tuckHeight: isCorner(resizing.edge) && resizing.height ? { ...state.tuckHeight, [resizing.edge]: resizing.height } : state.tuckHeight }
    : state;
  const docks = DOCKS.map((edge) => {
    const ids = (state.tucked?.[edge] ?? []).filter((id) => state.instances[id]);
    const kept = !!state.tuckKeep?.includes(edge);
    const floats = kept && !!state.tuckFloat?.includes(edge);
    const open = !!ids.length && (peek === edge || kept || drag?.from === edge);
    return { edge, ids, kept, floats, open, r: panelRect(edge, W, H, live) };
  });
  // Corners win over edges: an edge's hover strip stops short of a corner that has a dock.
  const cornerReach = (c: Corner) => {
    const n = (state.tucked?.[c] ?? []).filter((id) => state.instances[id]).length;
    return n ? Math.max(CORNER_HOT, n * PULL_ICON + (n - 1) * 6 + PULL_T * 2) : 0;
  };
  const hotStyle = (e: Edge): React.CSSProperties => (e === 'top' || e === 'bottom'
    ? { left: cornerReach(`${e}-left`), right: cornerReach(`${e}-right`) }
    : { top: cornerReach(`top-${e}`) && CORNER_HOT, bottom: cornerReach(`bottom-${e}`) && CORNER_HOT });
  return (
    <>
      {docks.map(({ edge, ids, kept, floats, open, r }) => {
        if (!ids.length) return null;
        const vertical = stacks(edge);
        const corner = isCorner(edge) ? edge : null;
        const pw = r.w, ph = r.h;
        // While a window is dragged over (or out of) this dock, the others reflow around a
        // placeholder slot where it will land; the dragged one follows the pointer.
        const dragged = drag && ids.includes(drag.id) ? drag.id : null;
        const others = ids.filter((id) => id !== dragged);
        const ghostAt = drag && drag.tuck === edge && drag.slot != null ? Math.min(drag.slot, others.length) : null;
        const shares = splitting?.edge === edge ? splitting.shares : state.tuckSplit?.[edge];
        const evenShares = ids.map(() => 1 / ids.length);
        const slots = panelSlots(edge, Math.max(1, others.length + (ghostAt != null ? 1 : 0)), r, dragged || ghostAt != null ? undefined : shares);
        const slotOf = (i: number) => slots[ghostAt != null && i >= ghostAt ? i + 1 : i];
        const stage = drag ? document.querySelector('.stage')?.getBoundingClientRect() : undefined;
        return (
          <Fragment key={edge}>
            {(() => {
              // The pull. No backing (Graphite Mono): docked windows float like any window, pinned to
              // the edge. Closed: a small graphite capsule of the docked apps' own icons, just in from
              // the edge; hovering the edge brightens it (it never moves, so hover can't flicker),
              // and a click opens the dock. Open: the capsule becomes a lock pill on the dock's
              // inner edge, shown while the pointer is over the dock: an open lock (keep it open) or a
              // closed one (kept open; click to release). Its title says so in words.
              const state3 = open ? 'open' : near === edge ? 'near' : 'idle';
              const M = 6; // the closed capsule's margin from the screen edge
              const capThick = PULL_ICON + PULL_T * 2;
              const capLen = ids.length * PULL_ICON + (ids.length - 1) * 6 + PULL_T * 2;
              const along = vertical ? r.y + r.h / 2 : r.x + r.w / 2;
              const B = GAP / 2; // mid-gap between the dock and the layout
              let cx: number, cy: number;
              if (corner) {
                const [v, h] = cornerSides(corner);
                [cx, cy] = state3 === 'open'
                  ? [h === 'left' ? r.x + r.w + B : r.x - B, r.y + r.h / 2]
                  : [h === 'left' ? M + capLen / 2 : W - M - capLen / 2, v === 'top' ? M + capThick / 2 : H - M - capThick / 2];
              } else {
                const inset = M + capThick / 2;
                [cx, cy] = state3 === 'open'
                  ? { left: [r.x + r.w + B, r.y + r.h / 2], right: [r.x - B, r.y + r.h / 2], top: [r.x + r.w / 2, r.y + r.h + B], bottom: [r.x + r.w / 2, r.y - B] }[edge as Edge]
                  : { left: [inset, along], right: [W - inset, along], top: [along, inset], bottom: [along, H - inset] }[edge as Edge];
              }
              const openIt = () => hold(edge);
              const toggleKeep = () => { void dispatch({ type: 'tuck.keep', edge, keep: !kept }); if (kept) setPeek(null); };
              const hovered = peek === edge || near === edge;
              const where = corner ? corner.replace('-', ' ') : edge;
              return (
                <>
                  {!kept && <div className={`edge-hot ${edge}${corner ? ' corner' : ''}`} style={corner ? undefined : hotStyle(edge as Edge)} onMouseEnter={() => enterPull(edge)} onMouseLeave={() => { setNear(null); release(); }} onClick={openIt} />}
                  <button className={`edge-cap ${edge} ${state3}${kept ? ' kept' : ''}${hovered ? ' hover' : ''}${corner ? ' corner' : ''}`} style={{ left: cx, top: cy }} aria-pressed={state3 === 'open' ? kept : undefined}
                    title={state3 === 'open' ? (kept ? `Release the ${where} dock: it hides until you hover its edge` : `Keep the ${where} dock open beside the layout`) : `Show ${ids.map((id) => state.instances[id].title).join(', ')}`}
                    onMouseEnter={() => enterPull(edge)} onMouseLeave={() => { setNear(null); release(); }} onClick={state3 === 'open' ? toggleKeep : openIt}>
                    {state3 === 'open'
                      ? <><svg viewBox="0 0 16 16" width="13" height="13" aria-hidden>
                          <rect x="3" y="7" width="10" height="7" rx="1.8" fill={kept ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" />
                          <path d={kept ? 'M5.5 7V5a2.5 2.5 0 0 1 5 0v2' : 'M5.5 7V5a2.5 2.5 0 0 1 4.9-.7'} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                        </svg></>
                      : ids.map((id) => <span key={id}><AppIcon type={state.instances[id].type} /></span>)}
                  </button>
                  {/* Kept open: float it over the layout (which keeps its room), or set it beside again. */}
                  {state3 === 'open' && kept && (
                    <button className={`edge-cap edge-float open${floats ? ' kept' : ''}${hovered ? ' hover' : ''}`} aria-pressed={floats}
                      style={stacks(edge) ? { left: cx, top: cy + 30 } : { left: cx + 30, top: cy }}
                      title={floats ? `Set the ${where} dock beside the layout again` : `Float the ${where} dock over the layout (the layout keeps its room)`}
                      onMouseEnter={() => enterPull(edge)} onMouseLeave={() => { setNear(null); release(); }}
                      onClick={() => void dispatch({ type: 'tuck.float', edge, float: !floats })}>
                      <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden>
                        <rect x="2" y="5" width="9" height="9" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" opacity=".55" />
                        <rect x="5" y="2" width="9" height="9" rx="1.6" fill={floats ? 'currentColor' : 'var(--surface-overlay)'} stroke="currentColor" strokeWidth="1.4" />
                      </svg>
                    </button>
                  )}
                </>
              );
            })()}
            <div className={`edge-panel ${edge}${open ? ' open' : ''}${kept ? ' kept' : ''}${floats ? ' floats' : ''}${peek === edge ? ' hover' : ''}${drag?.tuck === edge ? ' drop-on' : ''}${resizing?.edge === edge ? ' resizing' : ''}`}
              style={{ left: r.x, top: r.y, width: pw, height: ph }} onMouseEnter={() => hold(edge)} onMouseLeave={release}>
              {/* Resize from the inner side; a corner from its two inner sides and its inner corner.
                  A handle's class names the side of the stage its dock hugs (it sits opposite). */}
              {kept && !corner && <div className={`edge-resize ${edge}`} title="Drag to resize" onPointerDown={(e) => startResize(edge, stacks(edge) ? 'w' : 'h', e)} />}
              {kept && corner && (() => {
                const [v, h] = cornerSides(corner);
                return (<>
                  <div className={`edge-resize ${h}`} title="Drag to resize" onPointerDown={(e) => startResize(edge, 'w', e)} />
                  <div className={`edge-resize ${v}`} title="Drag to resize" onPointerDown={(e) => startResize(edge, 'h', e)} />
                  <div className={`edge-resize corner ${corner}`} title="Drag to resize" onPointerDown={(e) => startResize(edge, 'wh', e)} />
                </>);
              })()}
              {/* Drag the gap between two windows to change how they share the dock. */}
              {!drag && ids.length > 1 && slots.slice(0, -1).map((s, i) => (
                <div key={`split-${i}`} className={`edge-split ${vertical ? 'rows' : 'cols'}`} title="Drag to resize"
                  style={vertical ? { top: s.y + s.h, left: 0, width: pw, height: GAP } : { left: s.x + s.w, top: 0, height: ph, width: GAP }}
                  onPointerDown={(e) => startSplit(edge, i, shares?.length === ids.length ? shares : evenShares, r, e)} />
              ))}
              {ghostAt != null && <div className="drop-ghost" style={{ width: slots[ghostAt].w, height: slots[ghostAt].h, transform: `translate(${slots[ghostAt].x}px, ${slots[ghostAt].y}px)` }} />}
              {ids.map((id) => {
                const meta = state.instances[id];
                const isDragged = id === dragged && drag && stage;
                // The dragged window keeps its size and follows the pointer (panel-relative).
                const home = slotOf(Math.max(0, others.indexOf(id))) ?? slots[0];
                const own = panelSlots(edge, ids.length, r, shares)[ids.indexOf(id)];
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

