# CLAUDE.md — working in claude-glass

Read `README.md` first (what it is, how the pieces fit, settings), then `docs/apps.md` (the app format).

## North star: a window into Claude's desktop
Claude Glass is an interactive window onto what Claude is doing: Claude shows its work there,
and the user can answer back from it (messages, commands, approvals, questions, point and ask,
Stop). Tiling, dragging, desktops and settings shape how it's viewed.

- Everything that reaches the session goes through the mod; nothing else talks to Claude Code.
  Claude Code's own prompts always keep working too: every workflow (terminal, tmux, voice, IDE)
  takes input its own way, and the glass is one more, never the only one.
- Apps answer back only through permissions they declare: `twoWay` (hooks on mod events) and
  `session` (controls the mod carries out: prompt, fill, interrupt, compact, clear, model, any
  slash command; `SESSION_CONTROLS` in `src/apps/types.ts`). Something any app might want from
  the session belongs there, not behind a check on an app's name. The plan is `docs/plans/mods.md`.
- CLI first, no servers: the mod, the user and Claude all drive a glass through the
  `claude-glass` CLI over its Unix socket. Never add a port, HTTP endpoint or daemon.
- Not a file browser, IDE, or editor. Apps render what Claude did or chose to show.
- Claude uses the glass heavily and directs the user's attention: window order is a ranking of
  attention (primary at index 0, then secondary, tertiary), re-ranked when that ranking changes,
  not per topic or per tool call. The guide (`src/core/guide.ts`) says so; keep it that way.

## Commands
- `npm install` — deps (Electron, React, esbuild, vitest, playwright)
- `npm run build` — esbuild bundles everything into `dist/` (cli, main, preload, renderer)
- `npm test` — vitest unit + integration (`test/unit/*.spec.ts`, no Electron needed), then the
  mod's own tests in Claude Code's runtime (`claude plugin test .`: `hooks/*.test.ts`; that runner
  takes every `*.test.ts` in the plugin, so vitest files are `*.spec.ts`)
- `npm run typecheck` — `tsc --noEmit`
- `npm run e2e` — builds, launches Electron via Playwright, writes PNGs to `test/screenshots/`
- `npm run demo -- <session-id>` — opens a glass and seeds it with demo content (manual look)

## Rules of the road
- Core (`src/core`, `src/apps/*/index.ts`) must stay pure Node/TS: no Electron, no React, no DOM.
  It must run in plain Node (integration tests do exactly that).
- Every state change is a reducer action (`src/core/reducer.ts`). UI and CLI share actions.
  Never add a code path that mutates state outside the reducer.
- Apps use the app format (docs/apps.md); "mod" now only means the Claude Code mod. Built-in app = `src/apps/<type>/index.ts` (core,
  `export default`) + `view.tsx` (`export default`, `AppViewProps`) + `view.css`; register the
  core in `src/apps/registry.ts` and add the type to `FRAME_APPS` in `scripts/build.mjs`, which
  compiles it into an app folder in `dist/apps/<type>`. Views run in sandboxed frames and talk
  over the bridge (`src/sdk`). Only Settings is native. Mention a new app in the README.
- The mod (`hooks/glass-mod.ts`) must never block Claude: it queues events and sends them in the
  background (one `claude-glass event` at a time, in order), skips the CLI when no socket exists,
  and only awaits `session-start`. It runs in Claude Code's sandbox (no Node: everything through
  `$`), and `claude plugin validate .` must pass for it. Its event types mirror
  `src/core/events.ts` (`GlassEvent`); change both together.
- Tests: use `CLAUDE_GLASS_HOME` and `CLAUDE_GLASS_RUNTIME` pointed at temp dirs. Never touch
  the real `~/.claude/claude-glass` in tests.
- After any UI change, run `npm run e2e` and actually Read the screenshots in `test/screenshots/`.
- Don't install the plugin into the user's global Claude config; test with `--plugin-dir`.
- Keep the README current when behavior, settings or commands change. Regenerate its media with
  `node scripts/readme-media.mjs` when the look changes.

## Gotchas
- macOS Unix socket paths max 104 bytes → sockets live in `/tmp/claude-glass-<uid>/`.
- `test/fixtures/mod-events.ndjson` is a real session recorded through the mod — trust it over
  docs. Mod event shapes: the types Claude Code writes for your build (the plugin-authoring skill
  names the file); a tool's `result` is its own record (Edit's `structuredPatch`, Bash's `stdout`).
- Check the mod live with a headless session: `claude -p … --plugin-dir . --session-id <uuid>`
  against a `GlassCore` listening for that id in plain Node (temp `CLAUDE_GLASS_HOME`/`RUNTIME`).
- Mods sit behind Claude Code's server flag `tengu_plugin_hooks_modules`; a session that says
  they're off may have read a stale cache (`cachedGrowthBookFeatures` in `~/.claude.json`).
- The plugin is named `glass` (`glass@n33kos`, skill `/glass:glass`): Claude Code reserves plugin
  names starting with `claude-`. Everything else stays `claude-glass` (CLI, repo, app, home dir).
  The install lookups (`bin/claude-glass`, `src/core/update.ts`) match `glass@`.
- `CLAUDE_CODE_SESSION_ID` is set in the Bash tool environment; plugin env vars
  (`CLAUDE_PLUGIN_ROOT`) are NOT. Plugin `bin/` is on the Bash PATH. The mod finds the CLI at
  `$.plugin.root/bin/claude-glass` and passes `--session` itself.
- `require('electron')` from plain Node returns the Electron binary path (used by the CLI to spawn).
- The launcher runs the shared `~/.claude/claude-glass/app/<electron>-<icon>/Claude Glass.app` (macOS,
  named in `dist/app.json`), not plain Electron; behavior can differ. Don't make it per version:
  macOS ties the mic grant to its signature. The dock labels it by its `.app` folder name only, so
  each glass runs an APFS clone named after its project (`src/cli/launch.ts`); never edit a
  bundle's Info.plist (macOS then mutes the mic silently) and don't symlink (it resolves back). Test fixes against the real glass too: `CLAUDE_GLASS_DEBUG_PORT=9333 claude-glass open` exposes it over
  CDP (pages embedded in app frames are their own targets in `/json/list`).
- Embedded pages (an app's declared origins inside its frame) have storage partitioned under the
  glass; `clearStorageData({ origin })` doesn't reach it, only code running in the live frame does.
