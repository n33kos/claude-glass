// Wallpaper light colors: the user's own (global) or Claude's signal for one session.
// Hex only (#rgb or #rrggbb), so nothing but a color ever reaches the renderer's CSS.

export const MAX_COLORS = 4;
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** A list of colors from an array or a comma/space-separated string. Empty clears. Throws on anything else. */
export function parseColors(value: unknown): string[] {
  const list = Array.isArray(value) ? value.map(String) : String(value ?? '').split(/[\s,]+/);
  const colors = list.map((c) => c.trim()).filter(Boolean).map((c) => (c.startsWith('#') ? c : `#${c}`).toLowerCase());
  const bad = colors.find((c) => !HEX.test(c));
  if (bad) throw new Error(`"${bad}" is not a hex color (use #rgb or #rrggbb)`);
  if (colors.length > MAX_COLORS) throw new Error(`at most ${MAX_COLORS} colors`);
  return colors;
}
