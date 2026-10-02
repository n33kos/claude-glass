// What's on the glass, as text for Claude: `claude-glass view`, and the prompt context of
// viewContext. (GlassCore.view() builds the object; this writes it out.)
export function formatView(v: any): string {
  const lines = [`Claude Glass "${v.session.title}" · ${v.session.activity}${v.session.ended ? ' · session ended' : ''} · user is viewing desktop ${v.userViewingDesktop + 1}`];
  const d0 = v.display ?? {};
  lines.push(`Display: ${d0.nestedView ? 'nested view (index 0 = big pane)' : 'desktops'} · new things: ${d0.windowMode === 'history' ? 'a new window per action (history; windows stay in time order)' : 'update one window'}`);
  // Where a window sits: x/y ranges as % of the tiling area.
  const pos = (r: any) => (r ? `x ${Math.round(r.x * 100)}–${Math.round((r.x + r.w) * 100)}%, y ${Math.round(r.y * 100)}–${Math.round((r.y + r.h) * 100)}%` : 'not shown (too deep)');
  for (const d of v.desktops) {
    lines.push(`Desktop ${d.desktop + 1} [${d.layout}]`);
    if (!d.windows.length) lines.push('  (empty)');
    for (const w of d.windows) lines.push(`  ${String(w.index).padStart(2)}  ${w.id.padEnd(16)} ${w.type.padEnd(12)} ${w.title.padEnd(20)} ${pos(w.rect)}`);
  }
  for (const [dock, sb] of Object.entries(v.sidebars ?? {}) as [string, any][]) {
    const names = (v.tucked?.[dock] ?? []).map((w: any) => `${w.id} (${w.type})`).join(', ');
    const size = sb.height ? `${sb.size}×${sb.height}px` : `${sb.size}px`;
    lines.push(`Docked ${dock} (${sb.open ? `kept open${sb.float ? ' over the layout' : ''}, ${size}` : 'hidden until hovered'}): ${names}`);
  }
  if (v.overlays?.length) lines.push(`Overlays (over the whole glass, click-through): ${v.overlays.map((o: any) => `${o.id} (${o.type})`).join(', ')}`);
  if (v.closed.length) lines.push(`Closed: ${v.closed.map((c: any) => `${c.id} (${c.type})`).join(', ')}`);
  return lines.join('\n');
}
