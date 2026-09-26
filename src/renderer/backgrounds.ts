// Wallpapers. config.background is a preset name or an absolute image path.
import type { CSSProperties } from 'react';

export const BACKGROUNDS: Record<string, string> = {
  // Deep indigo dusk with teal and magenta light — the default.
  aurora: [
    'radial-gradient(60% 70% at 12% 18%, #2b6f8f 0%, transparent 60%)',
    'radial-gradient(55% 60% at 88% 12%, #7a3d8c 0%, transparent 62%)',
    'radial-gradient(70% 60% at 70% 95%, #1f4d7a 0%, transparent 60%)',
    'radial-gradient(45% 45% at 30% 85%, #a3486e 0%, transparent 65%)',
    'linear-gradient(160deg, #121633 0%, #0c1024 60%, #0a0d1c 100%)',
  ].join(','),
  dune: [
    'radial-gradient(70% 60% at 20% 10%, #f0b37e 0%, transparent 60%)',
    'radial-gradient(60% 60% at 90% 30%, #c0607a 0%, transparent 60%)',
    'radial-gradient(80% 60% at 50% 110%, #5b3a78 0%, transparent 60%)',
    'linear-gradient(180deg, #3a2a4a, #1d1630)',
  ].join(','),
  tide: [
    'radial-gradient(60% 60% at 15% 20%, #3fb7b0 0%, transparent 60%)',
    'radial-gradient(60% 60% at 85% 80%, #2d5fb8 0%, transparent 60%)',
    'linear-gradient(170deg, #0e2a3a, #081722)',
  ].join(','),
  graphite: 'radial-gradient(80% 80% at 50% 0%, #3a3f4b 0%, transparent 70%), linear-gradient(180deg, #23262e, #15171c)',
};

export function backgroundStyle(bg: string): CSSProperties {
  if (bg && bg.startsWith('/')) {
    return { backgroundImage: `url("canvas-file://f${encodeURI(bg)}")`, backgroundSize: 'cover', backgroundPosition: 'center' };
  }
  return { backgroundImage: BACKGROUNDS[bg] ?? BACKGROUNDS.aurora };
}
