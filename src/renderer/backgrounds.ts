// Wallpapers. config.background is a preset name or an absolute image path.
// Presets are a base gradient plus soft bokeh blobs. Blobs are separate layers so they can drift
// slowly on the compositor (transform only) without repainting the gradient.
import type { CSSProperties } from 'react';

export interface Blob { color: string; x: number; y: number; rx: number; ry: number } // % of the screen
export interface Preset { base: string; blobs: Blob[] }

export const PRESETS: Record<string, Preset> = {
  // Deep indigo dusk with teal and magenta light: the default.
  aurora: {
    base: 'linear-gradient(160deg, #121633 0%, #0c1024 60%, #0a0d1c 100%)',
    blobs: [
      { color: '#2b6f8f', x: 12, y: 18, rx: 36, ry: 42 },
      { color: '#7a3d8c', x: 88, y: 12, rx: 34, ry: 37 },
      { color: '#1f4d7a', x: 70, y: 95, rx: 42, ry: 36 },
      { color: '#a3486e', x: 30, y: 85, rx: 29, ry: 29 },
    ],
  },
  dune: {
    base: 'linear-gradient(180deg, #3a2a4a, #1d1630)',
    blobs: [
      { color: '#f0b37e', x: 20, y: 10, rx: 42, ry: 36 },
      { color: '#c0607a', x: 90, y: 30, rx: 36, ry: 36 },
      { color: '#5b3a78', x: 50, y: 110, rx: 48, ry: 36 },
    ],
  },
  tide: {
    base: 'linear-gradient(170deg, #0e2a3a, #081722)',
    blobs: [
      { color: '#3fb7b0', x: 15, y: 20, rx: 36, ry: 36 },
      { color: '#2d5fb8', x: 85, y: 80, rx: 36, ry: 36 },
    ],
  },
  graphite: {
    base: 'linear-gradient(180deg, #23262e, #15171c)',
    blobs: [{ color: '#3a3f4b', x: 50, y: 0, rx: 56, ry: 56 }],
  },
};


/** Flat CSS for a preset (settings swatches). */
export const BACKGROUNDS: Record<string, string> = Object.fromEntries(
  Object.entries(PRESETS).map(([name, p]) => [
    name,
    [...p.blobs.map((b) => `radial-gradient(${b.rx}% ${b.ry}% at ${b.x}% ${b.y}%, ${b.color}, transparent)`), p.base].join(','),
  ]),
);

/**
 * The wallpaper for a background setting. `colors` (the user's own, or Claude's signal for this
 * session) recolor the light: they cycle over the preset's blobs (aurora's four when the preset has
 * fewer). An image wallpaper gets the colored light over it only when there are colors.
 */
export function wallpaper(bg: string, colors: string[] = []): { style: CSSProperties; blobs: Blob[] } {
  const image = !!bg && bg.startsWith('/');
  const p = PRESETS[bg] ?? PRESETS.aurora;
  const slots = colors.length > p.blobs.length || (image && colors.length) ? PRESETS.aurora.blobs : p.blobs;
  const lit = colors.length ? slots.map((b, i) => ({ ...b, color: colors[i % colors.length] })) : image ? [] : p.blobs;
  return {
    style: image ? { backgroundImage: `url("glass-file://f${encodeURI(bg)}")`, backgroundSize: 'cover', backgroundPosition: 'center' } : { backgroundImage: p.base },
    blobs: lit,
  };
}

/*
 * The light is drawn on one small canvas (a quarter of the window's size) that CSS scales up:
 * the blobs are soft gradients, so it looks the same, but it costs one tiny texture instead of four
 * screen-sized GPU layers (about 110 MB of GPU memory on a retina screen), redrawn ~15 times a
 * second while drifting and not at all when still.
 */

// Drift: each blob eases through three poses (offset as a fraction of its box, scale, opacity) and
// back, on its own period, so the pattern never visibly repeats.
type Pose = [dx: number, dy: number, scale: number, alpha: number];
const DRIFTS: { period: number; phase: number; poses: [Pose, Pose, Pose] }[] = [
  { period: 38, phase: 0, poses: [[0, 0, 1, 1], [0.18, 0.12, 1.22, 0.7], [-0.12, 0.2, 0.88, 1]] },
  { period: 50, phase: 0, poses: [[0, 0, 1, 0.75], [-0.2, 0.14, 0.85, 1], [-0.08, -0.16, 1.18, 0.8]] },
  { period: 44, phase: 0, poses: [[0, 0, 1.1, 1], [0.14, -0.18, 0.92, 0.72], [0.2, 0.08, 1.15, 1]] },
  { period: 58, phase: 0.3, poses: [[-0.12, 0.2, 0.88, 1], [0.18, 0.12, 1.22, 0.7], [0, 0, 1, 1]] },
];

const rgb = (hex: string): [number, number, number] => {
  const h = hex.replace('#', '');
  const f = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [parseInt(f.slice(0, 2), 16), parseInt(f.slice(2, 4), 16), parseInt(f.slice(4, 6), 16)];
};

export interface LightPainter { set(blobs: Blob[], animate: boolean): void; stop(): void }

/** Paints `blobs` onto `canvas`, easing color changes over 1.6s and drifting when `animate`. */
export function paintLights(canvas: HTMLCanvasElement): LightPainter {
  const ctx = canvas.getContext('2d')!;
  let blobs: Blob[] = [];
  let from: [number, number, number][] = [], to: [number, number, number][] = [];
  let changedAt = 0, drifting = false, raf = 0, last = 0;
  const still = matchMedia('(prefers-reduced-motion: reduce)');

  const draw = (now: number) => {
    const W = Math.max(64, Math.round(canvas.clientWidth / 4)), H = Math.max(40, Math.round(canvas.clientHeight / 4));
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    ctx.clearRect(0, 0, W, H);
    const k = Math.min(1, (now - changedAt) / 1600), ease = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
    blobs.forEach((b, i) => {
      const c = to[i].map((v, j) => Math.round((from[i]?.[j] ?? v) + (v - (from[i]?.[j] ?? v)) * ease));
      const d = DRIFTS[i % DRIFTS.length];
      // Ping-pong 0 → 2 → 0 over the period, eased at the ends; poses 0–1 then 1–2.
      const u = drifting ? (1 - Math.cos(((now / 1000) / d.period + d.phase) * Math.PI * 2)) : 0;
      const [p, q] = u <= 1 ? [d.poses[0], d.poses[1]] : [d.poses[1], d.poses[2]];
      const f = u <= 1 ? u : u - 1;
      const [dx, dy, s, a] = p.map((v, j) => v + (q[j] - v) * f) as Pose;
      const rx = (b.rx / 100) * W * s, ry = (b.ry / 100) * H * s;
      const cx = (b.x / 100) * W + dx * (b.rx / 50) * W, cy = (b.y / 100) * H + dy * (b.ry / 50) * H;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(rx, ry);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
      g.addColorStop(0, `rgba(${c[0]},${c[1]},${c[2]},${a})`);
      g.addColorStop(1, `rgba(${c[0]},${c[1]},${c[2]},0)`); // same hue, so the edge doesn't go grey
      ctx.fillStyle = g;
      ctx.fillRect(-1, -1, 2, 2);
      ctx.restore();
    });
  };
  const loop = (now: number) => {
    raf = 0;
    const easing = now - changedAt < 1700;
    if (now - last >= 66 || easing) { last = now; draw(now); } // ~15 fps drifting, smooth while recoloring
    if (drifting || easing) raf = requestAnimationFrame(loop);
  };
  const kick = () => { if (!raf) raf = requestAnimationFrame(loop); };
  const ro = new ResizeObserver(() => { draw(performance.now()); kick(); });
  ro.observe(canvas);
  return {
    set(next, animate) {
      const now = performance.now();
      const nextTo = next.map((b) => rgb(b.color));
      // Recolor from wherever the ease currently is.
      from = to.length ? to.map((c, i) => c) : nextTo;
      if (nextTo.join() !== to.join()) changedAt = now;
      to = nextTo;
      blobs = next;
      canvas.dataset.colors = next.map((b) => b.color).join(',');
      drifting = animate && !still.matches;
      draw(now);
      kick();
    },
    stop() { cancelAnimationFrame(raf); ro.disconnect(); },
  };
}
