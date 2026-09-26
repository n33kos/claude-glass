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

const blobGradient = (b: Blob) => `radial-gradient(closest-side, ${b.color}, transparent)`;

/** Flat CSS for a preset (settings swatches). */
export const BACKGROUNDS: Record<string, string> = Object.fromEntries(
  Object.entries(PRESETS).map(([name, p]) => [
    name,
    [...p.blobs.map((b) => `radial-gradient(${b.rx}% ${b.ry}% at ${b.x}% ${b.y}%, ${b.color}, transparent)`), p.base].join(','),
  ]),
);

export function wallpaper(bg: string): { style: CSSProperties; blobs: { style: CSSProperties }[] } {
  if (bg && bg.startsWith('/')) {
    return { style: { backgroundImage: `url("glass-file://f${encodeURI(bg)}")`, backgroundSize: 'cover', backgroundPosition: 'center' }, blobs: [] };
  }
  const p = PRESETS[bg] ?? PRESETS.aurora;
  return {
    style: { backgroundImage: p.base },
    blobs: p.blobs.map((b) => ({
      style: {
        left: `${b.x - b.rx}%`, top: `${b.y - b.ry}%`, width: `${b.rx * 2}%`, height: `${b.ry * 2}%`,
        backgroundImage: blobGradient(b),
      },
    })),
  };
}
