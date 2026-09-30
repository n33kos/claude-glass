# CLAUDE.md — working in claude-glass

Read `README.md` first (what it is, how the pieces fit, settings), then `docs/apps.md` (the app format).

## North star: a window into Claude's desktop
Claude Glass is a one-way window into what Claude is doing. Claude shows; the user watches.
Tiling, dragging, desktops, and settings are conveniences for *viewing*, not ways to talk back.

- Prefer one-way (Claude → glass) for every feature. It keeps the architecture clean.
- Some user interaction is fine when it only changes how things are viewed (layout, opacity,
  which revision is shown). It must never need to reach Claude.
- Be very wary of two-way features (sending signals back into the Claude session). Every
  workflow (terminal, tmux, voice, IDE) receives input differently, and a back-channel would
  make the plugin hard for anyone else to adopt. If one is ever added, it must be optional and
  must not shape the core.
- Not a file browser, IDE, or editor. Apps render what Claude did or chose to show.
- Claude uses the glass heavily and directs the user's attention: window order is a ranking of
  attention (primary at index 0, then secondary, tertiary), re-ranked when that ranking changes,
  not per topic or per tool call. The guide (`src/core/guide.ts`) says so; keep it that way.

## Commands
- `npm install` — deps (Electron, React, esbuild, vitest, playwright)
- `npm run build` — esbuild bundles everything into `dist/` (cli, main, preload, renderer)
- `npm test` — vitest unit + integration (no Electron needed)
- `npm run typecheck` — `tsc --noEmit`
- `npm run e2e` — builds, launches Electron via Playwright, writes PNGs to `test/screenshots/`
- `npm run demo -- <session-id>` — opens a glass and seeds it with demo content (manual look)

## Rules of the road
- Core (`src/core`, `src/apps/*/index.ts`) must stay pure Node/TS: no Electron, no React, no DOM.
  It must run in plain Node (integration tests do exactly that).
- Every state change is a reducer action (`src/core/reducer.ts`). UI and CLI share actions.
  Never add a code path that mutates state outside the reducer.
- Apps use the mod format (docs/apps.md). Built-in app = `src/apps/<type>/index.ts` (core,
  `export default`) + `view.tsx` (`export default`, `AppViewProps`) + `view.css`; register the
  core in `src/apps/registry.ts` and add the type to `FRAME_APPS` in `scripts/build.mjs`, which
  compiles it into a mod folder in `dist/apps/<type>`. Views run in sandboxed frames and talk
  over the bridge (`src/sdk`). Only Settings is native. Mention a new app in the README.
- Hooks must never block Claude: forwarding hooks are `async: true`; `scripts/hook-forward.sh`
  exits immediately when no socket exists.
- Tests: use `CLAUDE_GLASS_HOME` and `CLAUDE_GLASS_RUNTIME` pointed at temp dirs. Never touch
  the real `~/.claude/claude-glass` in tests.
- After any UI change, run `npm run e2e` and actually Read the screenshots in `test/screenshots/`.
- Don't install the plugin into the user's global Claude config; test with `--plugin-dir`.
- Keep the README current when behavior, settings or commands change. Regenerate its media with
  `node scripts/readme-media.mjs` when the look changes.

## Gotchas
- macOS Unix socket paths max 104 bytes → sockets live in `/tmp/claude-glass-<uid>/`.
- Real hook payload shapes are in `test/fixtures/hook-payloads.ndjson` — trust those over docs.
  `MessageDisplay` = `{message_id, turn_id, index, final, delta}`.
- `CLAUDE_CODE_SESSION_ID` is set in the Bash tool environment; plugin env vars
  (`CLAUDE_PLUGIN_ROOT`) are NOT. Plugin `bin/` is on the Bash PATH.
- `require('electron')` from plain Node returns the Electron binary path (used by the CLI to spawn).
- The launcher runs `dist/Claude Glass.app` (macOS), not plain Electron; behavior can differ. Test
  fixes against the real glass too: `CLAUDE_GLASS_DEBUG_PORT=9333 claude-glass open` exposes it over
  CDP (pages embedded in app frames are their own targets in `/json/list`).
- Embedded pages (an app's declared origins inside its frame) have storage partitioned under the
  glass; `clearStorageData({ origin })` doesn't reach it, only code running in the live frame does.
