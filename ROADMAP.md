# Roadmap

Ideas and planned features, roughly in priority order. Everything here must fit the north star in
`CLAUDE.md`: primarily one-way; anything that reaches Claude is an app's opt-in permission. The
mods work (deterministic signals, the Action app, two-way apps, persistent app state) is planned
in `docs/plans/mods.md`.

## Done

- **Closing a window kept focus where it was** (nested view): closing the focused window focuses
  the one that takes its place, so closing neighbors walks along the row instead of jumping to the
  newest.
- **Docks** (renamed from sidebars / pins): the four edges plus four **corner docks**, each with its
  own target and hover trigger. A kept corner takes the end of its side's column; the edge dock
  fits beside it. Corners resize both ways from their inner corner. CLI: `window dock <id> <place>`.
- **Dock settings** (a Settings section): `dockOpen` click or hover.
- **Quieter pin buttons**: on a kept dock the pin is hidden until the pointer is over the dock.
- **Rounded inner corners** where open docks' backings meet: a small fillet (one radial-gradient
  element per inside corner, found generally from the backing rectangles).
- **Launcher** (renamed from the bottom "Dock"): `launcherAutoHide`, `launcherOrder` (the old
  `dockAutoHide` / `dockOrder` names still work, and config and presets migrate), and
  `launcherGroup` (on by default): an app's windows share one icon with a count and a menu.
- **Corner tabs** sit on an even L along both edges; **fillets** are concentric with the windows
  (window radius + half the gap).
- **One Images window**: `show <image>` always adds to `images` (every new glass has it, closed),
  with a Project tab listing the project folder's images (thumbnails cached like the rest).
- **Files → Changes**: clicking a changed file selects its diff in Changes and brings Changes into
  view (without reordering); the map's card has "Show the change".

- **Corners win over edges**: edge hover strips stop short of docked corners; corner triggers and
  tabs sit above edges and open docks. Fillets follow a resize live.
- **Files**: the map view is gone (list and tree remain).
- **App icons**: full-tile SVG artwork for every built-in app (src/renderer/icons), larger in
  their tiles; custom apps' own icon.svg still wins.
- **Guide**: Claude is told to use the glass heavily (show, then direct attention). Window order is
  a ranking of the user's attention (primary at 0, then secondary, tertiary); Claude re-ranks when
  that ranking changes, not per topic and not per tool call.

## Next

- Launcher: live state per icon (badges: tests failing, agent running, waiting on you).
- A dock pin's hover relies on the pointer crossing the shell; a pointer that jumps straight into
  an app frame isn't seen until it moves over the shell again. Worth checking by hand.
- README media: regenerate (`node scripts/readme-media.mjs`) with a corner dock and a launcher group.
