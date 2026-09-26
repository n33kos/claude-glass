# Claude Canvas — Plan & Design Record

> Living document. If you are an agent picking this up with no context: read this file top to
> bottom, then `README.md`, then `CLAUDE.md`. The "Status / Milestones" section at the bottom says
> exactly where work stopped. Update it as you go.

## 1. What this is

Claude Canvas is **Claude's monitor**: a native desktop window (Electron) bound to exactly one
Claude Code session. Hooks automatically stream what Claude is doing into it (conversation, tool
calls, diffs, plans), and Claude can deliberately put things on screen through a CLI
(`claude-canvas`). It works like a screen share from Claude to the user, which matters most
when the user talks to Claude by voice (Voice Multiplexer) and can't easily see what Claude sees.

It ships as a **Claude Code plugin** (hooks + skill + `bin/` CLI) plus an **Electron app**, all in
this repo.

## 2. Philosophy (non-negotiable unless the user changes them)

1. **Unix-level core.** The core is a UI-agnostic library: state + one reducer + a
   newline-delimited JSON protocol over **one Unix socket per session**. The CLI is a thin client.
   You could drive a canvas with `nc -U`. Electron is just the first renderer.
2. **One process per session.** No hub, no shared server. Each Claude session gets its own
   Electron process, socket, and window. A crash affects one session only.
3. **Same actions for everyone.** A drag in the UI and `claude-canvas window move` from the CLI go
   through the *same* reducer action. Commands are *relative* ops ("move X to index 0"), never
   "here is the whole layout", so Claude never clobbers the user's changes.
4. **Deterministic first.** Anything a hook can do (conversation, terminal, diffs, plans, images
   Claude reads) happens automatically with zero Claude tokens. Claude only spends effort on
   deliberate "let me show you this" moments.
5. **Off means off.** When the canvas isn't open, hooks exit immediately (socket-exists check) and
   nothing is recorded. Reopening a session's canvas restores its previous history (with a gap).
6. **Never block Claude.** All forwarding hooks run `async: true`; the socket client uses tight
   timeouts. A frozen canvas must never freeze Claude.
7. **Dead simple.** No over-engineering. Build the strong foundation, then grow by adding apps.
8. **One-way for MVP**, but the architecture must allow user→Claude later (the socket is
   bidirectional; UI actions already flow through the reducer; state is readable by the CLI).

## 3. Decisions (from the 2026-09-26 design interview)

| Topic | Decision |
|---|---|
| Runtime | Electron + React + TypeScript, macOS first |
| Process model | One Electron process per Claude session. Core = library inside Electron main, runnable in plain Node (for tests / future headless) |
| IPC | NDJSON over Unix socket, one request per connection |
| Session binding | `CLAUDE_CODE_SESSION_ID` is present in the Bash tool env (verified). Hooks get `session_id` in stdin JSON. CLI also accepts `--session` |
| Subagents | Share the parent's canvas (same session_id) |
| Conversation stream | `MessageDisplay` hook: `{message_id, turn_id, index, final, delta}` (verified by capture, see `test/fixtures/hook-payloads.ndjson`). No transcript tailing |
| Tool calls | `PreToolUse` / `PostToolUse` (`tool_use_id`, `tool_input`, `tool_response`, `duration_ms`) |
| When closed | Nothing recorded. Off means off |
| Auto start | `~/.claude/claude-canvas/config.json` → `autoStart` (default false). `/claude-canvas:canvas` skill or `claude-canvas open` otherwise |
| Window after session ends | Stays open; shows "session ended". Close is manual |
| Layout | Auto-tiling. ONE ordered array of open windows; desktops are pages cut from it; each desktop has a layout preset. New/reopened windows insert at index 0 (primary desktop, first slot); overflow spills to the next desktop |
| View control | The view (which desktop you're looking at) is never moved by Claude or by updates. Updates never reorder. Claude may deliberately `window move <id> 0` |
| Apps | React components in a registry with a shared interface (strategy pattern). Each declares defaults: singleton vs multi-instance, commands, init state |
| MVP apps | terminal (singleton, all tool calls, filterable), conversation (singleton), diff viewer, markdown viewer, image viewer, freeform HTML (sandboxed iframe — the only iframe), settings |
| Later | Live browser stream, user→Claude back-channel, subagents app, timeline scrubbing |
| Look | macOS/iOS glassy. Background (configurable in config.json, no UI yet), per-window opacity, dock at bottom with running indicators (optional auto-hide; icons follow window order), settings is an app. Close to macOS but deliberately distinguishable from the real desktop. Title bar: close + layout picker. Drag to reorder; drag to screen edge → next desktop |
| Settings | Global (config.json) and per-session (session state), separated |
| Instructions to Claude | A plugin skill (only its description sits in context) + `claude-canvas open` prints the usage guide when the canvas turns on. SessionStart re-injects the guide only if the canvas is live (autostart / resume / compact) |

## 4. Architecture

```
Claude Code session ──hooks (async)──► scripts/hook-forward.sh ──nc -U──┐
        │                                                               │
        └─ Bash tool: `claude-canvas <cmd>` (bin/ on PATH) ──socket─────┤
                                                                        ▼
                          ┌──────────── Electron main process (1 per session) ───────────┐
                          │  core/server.ts   Unix socket, NDJSON, one req per connection │
                          │  core/store.ts    state + reducer + persistence (debounced)  │
                          │  core/hooks.ts    hook payload → actions                      │
                          │  apps/*/index.ts  app definitions (commands, init, reduce)    │
                          └───────────────▲──────────────────────────┬───────────────────┘
                                   ipc: dispatch(action)       ipc: state patches
                          ┌───────────────┴──────────────────────────▼───────────────────┐
                          │  renderer (React): Desktop · WindowFrame · Dock · app views  │
                          └──────────────────────────────────────────────────────────────┘
```

### 4.1 Files on disk

```
~/.claude/claude-canvas/                (override: CLAUDE_CANVAS_HOME)
  config.json                           global settings
  sessions/<session-id>/
    state.json                          full canvas state (layout, instances, per-app state)
    files/                              copies of images etc. put on the canvas
    canvas.log                          Electron stdout/stderr
/tmp/claude-canvas-<uid>/<session-id>.sock   (override: CLAUDE_CANVAS_RUNTIME)
```
Sockets live in /tmp because macOS limits Unix socket paths to 104 bytes.

MVP persists the whole canvas as one `state.json` (debounced). Each app owns its own slice
(`appState[instanceId]`), so splitting into per-app files later is mechanical.

### 4.2 Protocol

Request (one JSON line): `{"op": "...", ...}`. Response (one JSON line): `{"ok":true,"result":...}`
or `{"ok":false,"error":"..."}`; server then closes the connection.

| op | fields | result |
|---|---|---|
| `ping` | | `{session, pid}` |
| `hook` | `payload` (raw hook JSON) | `null` |
| `dispatch` | `action` | reducer result (e.g. created instance id) |
| `view` | | compact layout summary |
| `state` | `id?` | full state or one instance's app state |
| `catalog` | | app types + commands |
| `quit` | | `null` then process exits |

### 4.3 State model (`src/core/types.ts`)

```ts
CanvasState {
  version: 1
  session: { id, cwd, title, startedAt, endedAt?, activity: 'idle'|'working' }
  order: string[]                // open windows, index 0 = primary desktop first slot
  pinned?: Record<id, slot>      // pinned windows stay at their slot; the rest flow around them
  desktops: LayoutName[]         // per-desktop layout; auto-extended with defaultLayout
  instances: Record<id, { id, type, title, createdAt, opacity? }>
  appState: Record<id, unknown>  // owned by each app's reducer
  settings: SessionSettings      // per-session overrides
  ui: { viewingDesktop }         // reported by renderer; read-only for Claude
}
```

Layouts: `full`(1) · `split`(2 side by side) · `main-left`(1 big + 2 small) · `columns`(3 tall) ·
`grid`(2×2). `computeDesktops()` slices `order` across desktops by slot count.

### 4.4 Actions (the shared reducer)

`window.open {id}` (moves to 0) · `window.close {id}` · `window.move {id, index}` ·
`window.pin {id, index?}` · `window.unpin {id}` · `window.opacity {id, value}` · `desktop.layout {desktop, layout}` ·
`instance.create {type, id?, title?, open?}` · `instance.rename {id, title}` ·
`app.command {id, command, args}` · `settings.set {scope, key, value}` ·
`ui.viewDesktop {index}` · `hook {payload}`.

### 4.5 Hook → action mapping (`src/core/hooks.ts`)

| Hook | Effect |
|---|---|
| UserPromptSubmit | conversation: user message; session activity=working |
| MessageDisplay | conversation: assemble chunk by (message_id, index) |
| PreToolUse | terminal: running entry |
| PostToolUse | terminal: finish entry. Edit/Write/MultiEdit/NotebookEdit → `changes` diff viewer. Write of a plan file / ExitPlanMode → `plan` markdown viewer. Read of an image → `images` viewer |
| Stop | activity=idle, conversation turn closed |
| SubagentStart/Stop | terminal marker lines |
| SessionEnd | session.endedAt set; window stays open |

Auto-created viewers open once (inserted at 0) the first time; if the user closes them they stay
closed (updates don't reopen/reorder). Controlled by session settings `autoOpen.*`.

### 4.6 CLI (`claude-canvas`)

```
claude-canvas open [--session ID]        launch (or detect) this session's canvas; prints guide
claude-canvas close                       quit this session's canvas
claude-canvas status [--all]              list canvases (running / closed)
claude-canvas view                        compact layout: desktops, slots, windows, closed apps
claude-canvas catalog                     app types and their commands
claude-canvas show <file> [--title T]     smart: .md→markdown, image→image, .html→html, else markdown code block
claude-canvas new <type> [--id ID] [--title T] [--no-open]
claude-canvas app <id> <command> [--key value ...] [--file F] [--text T]
claude-canvas window open|close <id>
claude-canvas window move <id> <index>
claude-canvas window pin <id> [index] | unpin <id>
claude-canvas window opacity <id> <0..1>
claude-canvas layout <desktop#> <full|split|main-left|columns|grid>
claude-canvas settings [get | set <scope> <key> <value>]
claude-canvas hook                        (internal) forward stdin hook JSON
claude-canvas session-start-hook          (internal) SessionStart handler (autostart + guide)
```
Session resolution: `--session` > `CLAUDE_CANVAS_SESSION` > `CLAUDE_CODE_SESSION_ID`.

### 4.7 Apps (`src/apps/<type>/`)

Each app: `index.ts` (core definition: `type, title, icon, singleton, description, commands,
init(), command(state, cmd, args)`) and `view.tsx` (React view: `({state, instance, size,
dispatch})`). Registered in `src/apps/registry.ts` (core) and `src/renderer/views.ts` (views).

| App | Singleton | Commands | View |
|---|---|---|---|
| terminal | yes | `log --text`, `clear` | tool calls as terminal lines, collapsible output, type filter chips |
| conversation | yes | `clear` | chat bubbles, streaming |
| diff | no (`changes` auto) | `add --path --before --after` / `clear` | file tabs, flip ◀ ▶ through revisions |
| markdown | no (`plan` auto) | `set --text/--file`, `append` | rendered markdown |
| image | no (`images` auto) | `add --file [--caption]` | flip ◀ ▶ |
| html | no | `render --text/--file` | sandboxed iframe (`allow-scripts`, no same-origin) |
| settings | yes | — | global + session settings form |

## 5. Testing strategy

- **Unit (vitest)**: layout math, reducer, hook mapping (using real captured payloads), app
  reducers, protocol. `npm test`.
- **Integration (vitest)**: start the core server in plain Node on a temp home/runtime dir,
  drive it with the real CLI and `scripts/hook-forward.sh`.
- **Visual/E2E (Playwright `_electron`)**: `npm run e2e` launches Electron against a temp home,
  seeds it via the CLI/hook fixtures, and writes screenshots to `test/screenshots/`. Agents must
  *look* at them (Read the PNGs) after UI changes.
- **Plugin smoke test**: `claude -p --plugin-dir .` headless run with a temp `CLAUDE_CANVAS_HOME`,
  canvas open, verify state.json receives conversation/terminal/diff entries.

## 6. Status / Milestones

- [x] M0 Design interview, hook payload capture (`test/fixtures/hook-payloads.ndjson`)
- [x] M1 Repo scaffold, docs, build pipeline
- [x] M2 Core: types, layout, reducer, apps (core side), hooks mapping + unit tests
- [x] M3 Core server + CLI + hook-forward script + integration tests
- [x] M4 Electron main + preload + renderer shell (desktops, frames, dock) + screenshots
- [x] M5 App views (terminal, conversation, diff, markdown, image, html, settings) + screenshots
- [x] M6 Plugin packaging (hooks.json, skill, bin), headless plugin smoke test
- [x] M7 Polish: drag reorder, edge-drag to next desktop, opacity, background config, dock icon

**MVP complete (2026-09-26).** Verified: 28 unit/integration tests, Playwright e2e (15 checks +
screenshots), and a real headless `claude -p --plugin-dir . --session-id <uuid>` run with a live
canvas (hooks, bin on PATH, session binding, CLI all work).

### Post-MVP feedback round (2026-09-26)
- [x] Pin a window to its slot (title-bar pin button, `window pin/unpin`); others flow around it
- [x] Look less like real macOS: blue (not yellow) "move to front" light; darker, squarer dock,
      no magnify, bar-style running indicator
- [x] Dock auto-hide (global `dockAutoHide`): dock overlays, stage takes its space, 6px bottom
      hot zone reveals it
- [x] Dock order follows window order (global `dockOrder`: `windows` default, or `fixed` by type)

### Next candidates (not started)
- Browser stream app (Playwright screencast into a window)
- User→Claude back-channel (e.g. "point at this window" → UserPromptSubmit context)
- `/clear` rebinding: SessionStart with source=clear could hand the old canvas to the new id
- Per-app storage files instead of one state.json; state size limits for huge sessions
- Packaged .app (electron-builder) so the dock shows "Claude Canvas" instead of "Electron"
- Placeholder ghost slot while dragging; keyboard reorder
- **Image lightbox**: clicking an image in the image viewer opens it as a full-canvas overlay with
  wheel/pinch zoom and drag to pan; Esc (or clicking the backdrop) closes it. Renderer-only
  (view state, no reducer action), so it's small. Good for small screenshots and diagrams.
- **Thoughts app** (explore first, skip if it's unreasonable): list Claude's thinking. No hook
  carries thinking (the captured `MessageDisplay` payloads only have visible text), so the only
  source is the session transcript JSONL, whose path (`transcript_path`) arrives in every hook
  payload. Idea: on `Stop` (and maybe `PostToolUse`), have core read new transcript lines from
  a saved byte offset and push `thinking` blocks into a singleton `thoughts` app. Open questions:
  whether transcripts hold readable thinking or only redacted/signature blocks, and whether
  reading the transcript counts as the "no transcript tailing" rule from §3. Check a real
  transcript before building anything.

## 7. Future ideas (not MVP)

Browser stream app (Playwright screencast), user→Claude back-channel (point at a window),
subagents app, per-app files instead of one state.json, timeline scrubbing, Linux support.
