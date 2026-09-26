# CLAUDE.md — working in claude-canvas

Read `PLAN.md` first (design record + milestone status), then `README.md`.

## Commands
- `npm install` — deps (Electron, React, esbuild, vitest, playwright)
- `npm run build` — esbuild bundles everything into `dist/` (cli, main, preload, renderer)
- `npm test` — vitest unit + integration (no Electron needed)
- `npm run typecheck` — `tsc --noEmit`
- `npm run e2e` — builds, launches Electron via Playwright, writes PNGs to `test/screenshots/`
- `npm run demo -- <session-id>` — opens a canvas and seeds it with demo content (manual look)

## Rules of the road
- Core (`src/core`, `src/apps/*/index.ts`) must stay pure Node/TS: no Electron, no React, no DOM.
  It must run in plain Node (integration tests do exactly that).
- Every state change is a reducer action (`src/core/reducer.ts`). UI and CLI share actions.
  Never add a code path that mutates state outside the reducer.
- New app = `src/apps/<type>/index.ts` + `view.tsx`, register in `src/apps/registry.ts` and
  `src/renderer/views.ts`. Update the app table in PLAN.md.
- Hooks must never block Claude: forwarding hooks are `async: true`; `scripts/hook-forward.sh`
  exits immediately when no socket exists.
- Tests: use `CLAUDE_CANVAS_HOME` and `CLAUDE_CANVAS_RUNTIME` pointed at temp dirs. Never touch
  the real `~/.claude/claude-canvas` in tests.
- After any UI change, run `npm run e2e` and actually Read the screenshots in `test/screenshots/`.
- Don't install the plugin into the user's global Claude config; test with `--plugin-dir`.
- Commit at each milestone (local git only, never push). Update PLAN.md "Status" when you do.

## Gotchas
- macOS Unix socket paths max 104 bytes → sockets live in `/tmp/claude-canvas-<uid>/`.
- Real hook payload shapes are in `test/fixtures/hook-payloads.ndjson` — trust those over docs.
  `MessageDisplay` = `{message_id, turn_id, index, final, delta}`.
- `CLAUDE_CODE_SESSION_ID` is set in the Bash tool environment; plugin env vars
  (`CLAUDE_PLUGIN_ROOT`) are NOT. Plugin `bin/` is on the Bash PATH.
- `require('electron')` from plain Node returns the Electron binary path (used by the CLI to spawn).
