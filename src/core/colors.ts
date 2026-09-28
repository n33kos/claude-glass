// Wallpaper light colors: the user's own (global) or Claude's signal for one session.
// Hex only (#rgb or #rrggbb), so nothing but a color ever reaches the renderer's CSS.

export const MAX_COLORS = 4;
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** What the session is doing, as the wallpaper shows it when state colors are on. */
export type Mood = 'working' | 'waiting' | 'idle' | 'ended';
export const MOODS: Mood[] = ['working', 'waiting', 'idle', 'ended'];
export type Palettes = Record<Mood, string[]>;

/** Defaults: working keeps the user's own light; waiting on the user is amber (like the edge glow),
 *  done/your turn is green, an ended session goes graphite. Empty = the user's own colors. */
export const DEFAULT_PALETTES: Palettes = {
  working: [],
  waiting: ['#e0a030', '#b8641e', '#f0c060'],
  idle: ['#27ae60', '#138d75', '#52be80'],
  ended: ['#4a4f5c', '#2b2f38'],
};

export function moodOf(session: { activity: 'idle' | 'working'; waiting?: unknown; endedAt?: number }): Mood {
  if (session.endedAt) return 'ended';
  if (session.waiting) return 'waiting';
  return session.activity === 'working' ? 'working' : 'idle';
}

/** Palettes from config (object or JSON), validated; missing moods get their defaults. */
export function parsePalettes(value: unknown): Palettes {
  const raw = typeof value === 'string' ? JSON.parse(value) : (value ?? {});
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('statePalettes must be an object of mood → colors');
  const unknown = Object.keys(raw).find((k) => !MOODS.includes(k as Mood));
  if (unknown) throw new Error(`unknown mood "${unknown}" (moods: ${MOODS.join(', ')})`);
  return Object.fromEntries(MOODS.map((m) => [m, m in raw ? parseColors(raw[m]) : DEFAULT_PALETTES[m]])) as Palettes;
}

/**
 * The wallpaper light right now: Claude's one-off colors for this glass win, then the state
 * palette (when state colors are on and the mood has one), then the user's own, else the preset's.
 */
export function lightColors(opts: { signal?: string[]; stateColors: boolean; palettes: Palettes; mood: Mood; own: string[] }): string[] {
  if (opts.signal?.length) return opts.signal;
  const p = opts.stateColors ? opts.palettes[opts.mood] : [];
  return p?.length ? p : opts.own;
}

/** A list of colors from an array or a comma/space-separated string. Empty clears. Throws on anything else. */
export function parseColors(value: unknown): string[] {
  const list = Array.isArray(value) ? value.map(String) : String(value ?? '').split(/[\s,]+/);
  const colors = list.map((c) => c.trim()).filter(Boolean).map((c) => (c.startsWith('#') ? c : `#${c}`).toLowerCase());
  const bad = colors.find((c) => !HEX.test(c));
  if (bad) throw new Error(`"${bad}" is not a hex color (use #rgb or #rrggbb)`);
  if (colors.length > MAX_COLORS) throw new Error(`at most ${MAX_COLORS} colors`);
  return colors;
}
