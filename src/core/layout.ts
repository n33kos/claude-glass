// Tiling math: one ordered window array, cut into desktops by each desktop's layout.
import type { Edge, LayoutName } from './types';

/** Edges a window can be tucked into (out of the tiling flow). */
export const EDGES: Edge[] = ['left', 'right', 'top', 'bottom'];

/**
 * An edge sidebar's size in a W×H stage: width for left/right, height for top/bottom. The user's
 * dragged size if set (clamped to the stage), else a default.
 */
export function edgeSize(edge: Edge, W: number, H: number, sizes?: Partial<Record<Edge, number>>): number {
  const vertical = edge === 'left' || edge === 'right';
  const def = vertical ? Math.min(480, Math.max(320, W * 0.32)) : Math.min(380, Math.max(240, H * 0.38));
  const [min, max] = vertical ? [200, W * 0.7] : [140, H * 0.7];
  return Math.round(Math.max(min, Math.min(max, sizes?.[edge] ?? def)));
}

export interface SlotRect { x: number; y: number; w: number; h: number } // fractions 0..1

export const LAYOUTS: Record<LayoutName, { label: string; slots: SlotRect[] }> = {
  full: { label: 'Full', slots: [{ x: 0, y: 0, w: 1, h: 1 }] },
  split: { label: 'Side by side', slots: [{ x: 0, y: 0, w: 0.5, h: 1 }, { x: 0.5, y: 0, w: 0.5, h: 1 }] },
  'main-left': {
    label: 'One big, two small',
    slots: [{ x: 0, y: 0, w: 0.6, h: 1 }, { x: 0.6, y: 0, w: 0.4, h: 0.5 }, { x: 0.6, y: 0.5, w: 0.4, h: 0.5 }],
  },
  columns: {
    label: 'Three tall',
    slots: [{ x: 0, y: 0, w: 1 / 3, h: 1 }, { x: 1 / 3, y: 0, w: 1 / 3, h: 1 }, { x: 2 / 3, y: 0, w: 1 / 3, h: 1 }],
  },
  // Experiment: every window on one desktop, each older one in half of what's left (a spiral).
  // Slots are computed per window count by nestedSlots(); this list is only for the menu icon.
  nested: {
    label: 'Nested',
    slots: [{ x: 0, y: 0, w: 0.5, h: 1 }, { x: 0.5, y: 0, w: 0.5, h: 0.5 }, { x: 0.75, y: 0.5, w: 0.25, h: 0.5 }, { x: 0.5, y: 0.5, w: 0.25, h: 0.5 }],
  },
  grid: {
    label: 'Grid',
    slots: [{ x: 0, y: 0, w: 0.5, h: 0.5 }, { x: 0.5, y: 0, w: 0.5, h: 0.5 }, { x: 0, y: 0.5, w: 0.5, h: 0.5 }, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }],
  },
};

// Choosable per desktop. Nested isn't: it's a whole-glass view (global `nestedView`).
export const LAYOUT_NAMES = (Object.keys(LAYOUTS) as LayoutName[]).filter((l) => l !== 'nested');

/** Desktops to lay out: the glass's own, or one nested page when the nested view is on. */
export const desktopsFor = (desktops: LayoutName[], nestedView: boolean): LayoutName[] => (nestedView ? ['nested'] : desktops);

export const NESTED_DEPTH = 6; // panes past this are too small to read; they stay hidden

/** The nested spiral: pane i takes half of what's left, turning left → top → right → bottom. */
export function nestedSlots(n: number): SlotRect[] {
  const out: SlotRect[] = [];
  let r: SlotRect = { x: 0, y: 0, w: 1, h: 1 };
  const count = Math.min(n, NESTED_DEPTH);
  for (let i = 0; i < count; i++) {
    if (i === count - 1) { out.push(r); break; }
    const side = i % 4;
    if (side === 0) { out.push({ ...r, w: r.w / 2 }); r = { ...r, x: r.x + r.w / 2, w: r.w / 2 }; }
    else if (side === 1) { out.push({ ...r, h: r.h / 2 }); r = { ...r, y: r.y + r.h / 2, h: r.h / 2 }; }
    else if (side === 2) { out.push({ ...r, x: r.x + r.w / 2, w: r.w / 2 }); r = { ...r, w: r.w / 2 }; }
    else { out.push({ ...r, y: r.y + r.h / 2, h: r.h / 2 }); r = { ...r, h: r.h / 2 }; }
  }
  return out;
}

export function isLayout(v: unknown): v is LayoutName {
  return typeof v === 'string' && v in LAYOUTS && v !== 'nested'; // nested is the global nestedView, not a desktop layout
}

export interface DesktopPage {
  index: number;
  layout: LayoutName;
  start: number; // index into order of the first slot
  windows: string[]; // ids actually placed (may be fewer than slots)
}

/** The layout that fits `n` windows best (used by the "claude" default). */
export function fitLayout(n: number): LayoutName {
  return n <= 1 ? 'full' : n === 2 ? 'split' : n === 3 ? 'main-left' : 'grid';
}

export const isDefaultLayout = (v: unknown): v is LayoutName | 'claude' => v === 'claude' || isLayout(v);

/**
 * Slice `order` across desktops. Desktops beyond `desktops` use `fallback`; fallback "claude"
 * fits each new desktop to the windows left to place. Always >= 1 page.
 */
export function computeDesktops(order: string[], desktops: LayoutName[], fallback: LayoutName | 'claude'): DesktopPage[] {
  const pages: DesktopPage[] = [];
  let start = 0;
  let i = 0;
  do {
    const layout = desktops[i] ?? (fallback === 'claude' ? fitLayout(order.length - start) : fallback);
    const n = layout === 'nested' ? Math.max(1, order.length - start) : LAYOUTS[layout].slots.length; // nested takes every window
    pages.push({ index: i, layout, start, windows: order.slice(start, start + n) });
    start += n;
    i++;
  } while (start < order.length || i < desktops.length);
  // Drop trailing empty desktops beyond the first.
  while (pages.length > 1 && pages[pages.length - 1].windows.length === 0) pages.pop();
  return pages;
}

/**
 * When a window's desktop has fewer windows than slots (last desktop), the layout still has
 * empty slots. The renderer stretches: for a partially filled final desktop we pick the layout
 * of matching size so there are no holes.
 */
export function effectiveLayout(page: DesktopPage): LayoutName {
  if (page.layout === 'nested') return 'nested';
  const n = page.windows.length;
  const want = LAYOUTS[page.layout].slots.length;
  if (n >= want || n === 0) return page.layout;
  if (n === 1) return 'full';
  if (n === 2) return 'split';
  return page.layout === 'grid' ? 'main-left' : page.layout;
}
