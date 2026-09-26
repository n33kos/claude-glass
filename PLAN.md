# Claude Glass — Plan & Design Record

> Living document. If you are an agent picking this up with no context: read this file top to
> bottom, then `README.md`, then `CLAUDE.md`. The "Status / Milestones" section at the bottom says
> exactly where work stopped. Update it as you go.

## 1. What this is

Claude Glass is **Claude's monitor**: a native desktop window (Electron) bound to exactly one
Claude Code session. Hooks automatically stream what Claude is doing into it (conversation, tool
calls, diffs, plans), and Claude can deliberately put things on screen through a CLI
(`claude-glass`). It works like a screen share from Claude to the user, which matters most
when the user talks to Claude by voice (Voice Multiplexer) and can't easily see what Claude sees.

It ships as a **Claude Code plugin** (hooks + skill + `bin/` CLI) plus an **Electron app**, all in
this repo.

## 2. Philosophy (non-negotiable unless the user changes them)

1. **Unix-level core.** The core is a UI-agnostic library: state + one reducer + a
   newline-delimited JSON protocol over **one Unix socket per session**. The CLI is a thin client.
   You could drive a glass with `nc -U`. Electron is just the first renderer.
2. **One process per session.** No hub, no shared server. Each Claude session gets its own
   Electron process, socket, and window. A crash affects one session only.
3. **Same actions for everyone.** A drag in the UI and `claude-glass window move` from the CLI go
   through the *same* reducer action. Commands are *relative* ops ("move X to index 0"), never
   "here is the whole layout", so Claude never clobbers the user's changes.
4. **Deterministic first.** Anything a hook can do (conversation, terminal, diffs, plans, images
   Claude reads) happens automatically with zero Claude tokens. Claude only spends effort on
   deliberate "let me show you this" moments.
5. **Off means off.** When the glass isn't open, hooks exit immediately (socket-exists check) and
   nothing is recorded. Reopening a session's glass restores its previous history (with a gap).
6. **Never block Claude.** All forwarding hooks run `async: true`; the socket client uses tight
   timeouts. A frozen glass must never freeze Claude.
7. **Dead simple.** No over-engineering. Build the strong foundation, then grow by adding apps.
8. **One-way by design.** Claude shows; the user watches. User interaction only changes how
   things are viewed (layout, opacity, which revision is shown) and never reaches Claude. No
   user→Claude back-channel: every workflow (terminal, tmux, voice, IDE) takes input differently,
   and one would make the plugin hard to adopt. See the north star in `CLAUDE.md`.

## 3. Decisions (from the 2026-09-26 design interview)

| Topic | Decision |
|---|---|
| Name | **Claude Glass** (`claude-glass`), renamed from Claude Canvas on 2026-09-26: `claude-canvas` was taken by a two-way tmux plugin and `claude-lens` by several dashboards. A Claude glass is Claude Lorrain's tinted viewing mirror; it fits the one-way north star |
| Runtime | Electron + React + TypeScript, macOS first |
| Process model | One Electron process per Claude session. Core = library inside Electron main, runnable in plain Node (for tests / future headless) |
| IPC | NDJSON over Unix socket, one request per connection |
| Session binding | `CLAUDE_CODE_SESSION_ID` is present in the Bash tool env (verified). Hooks get `session_id` in stdin JSON. CLI also accepts `--session` |
| Subagents | Share the parent's glass (same session_id) |
| Conversation stream | `MessageDisplay` hook: `{message_id, turn_id, index, final, delta}` (verified by capture, see `test/fixtures/hook-payloads.ndjson`). No transcript tailing |
| Tool calls | `PreToolUse` / `PostToolUse` (`tool_use_id`, `tool_input`, `tool_response`, `duration_ms`) |
| When closed | Nothing recorded. Off means off |
| Auto start | `~/.claude/claude-glass/config.json` → `autoStart` (default false). `/claude-glass:glass` skill or `claude-glass open` otherwise |
| Window after session ends | Stays open; shows "session ended". Close is manual |
| Layout | Auto-tiling. ONE ordered array of open windows; desktops are pages cut from it; each desktop has a layout preset. New/reopened windows insert at index 0 (primary desktop, first slot); overflow spills to the next desktop |
| View control | The view (which desktop you're looking at) is never moved by Claude or by updates. Updates never reorder. Claude may deliberately `window move <id> 0` |
| Apps | React components in a registry with a shared interface (strategy pattern). Each declares defaults: singleton vs multi-instance, commands, init state |
| MVP apps | terminal (singleton, all tool calls, filterable), conversation (singleton), diff viewer, markdown viewer, image viewer, freeform HTML (sandboxed iframe — the only iframe), settings |
| Later | Subagents app |
| Look | macOS/iOS glassy. Background (configurable in config.json, no UI yet), per-window opacity, dock at bottom with running indicators (optional auto-hide; icons follow window order), settings is an app. Close to macOS but deliberately distinguishable from the real desktop. Title bar: close + layout picker. Drag to reorder; drag to screen edge → next desktop |
| Settings | Global (config.json) and per-session (session state), separated |
| Instructions to Claude | A plugin skill (only its description sits in context) + `claude-glass open` prints the usage guide when the glass turns on. SessionStart re-injects the guide only if the glass is live (autostart / resume / compact) |

## 4. Architecture

```
Claude Code session ──hooks (async)──► scripts/hook-forward.sh ──nc -U──┐
        │                                                               │
        └─ Bash tool: `claude-glass <cmd>` (bin/ on PATH) ──socket─────┤
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
~/.claude/claude-glass/                (override: CLAUDE_GLASS_HOME)
  config.json                           global settings
  sessions/<session-id>/
    state.json                          full glass state (<id> = session id, or folder hash in folder scope) (layout, instances, per-app state)
    files/                              copies of images etc. put on the glass
    glass.log                          Electron stdout/stderr
/tmp/claude-glass-<uid>/<session-id>.sock   (override: CLAUDE_GLASS_RUNTIME)
```
Sockets live in /tmp because macOS limits Unix socket paths to 104 bytes.

MVP persists the whole glass as one `state.json` (debounced). Each app owns its own slice
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
GlassState {
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

### 4.6 CLI (`claude-glass`)

```
claude-glass open [--session ID]        launch (or detect) this session's glass; prints guide
claude-glass close                       quit this session's glass
claude-glass status [--all]              list glass windows (running / closed)
claude-glass view                        compact layout: desktops, slots, windows, closed apps
claude-glass catalog                     app types and their commands
claude-glass show <file> [--title T]     smart: .md→markdown, image→image, .html→html, else markdown code block
claude-glass new <type> [--id ID] [--title T] [--no-open]
claude-glass app <id> <command> [--key value ...] [--file F] [--text T]
claude-glass window open|close <id>
claude-glass window move <id> <index>
claude-glass window pin <id> [index] | unpin <id>
claude-glass window opacity <id> <0..1>
claude-glass layout <desktop#> <full|split|main-left|columns|grid>
claude-glass settings [get | set <scope> <key> <value>]
claude-glass hook                        (internal) forward stdin hook JSON
claude-glass session-start-hook          (internal) SessionStart handler (autostart + guide)
```
Session resolution: `--session` > `CLAUDE_GLASS_SESSION` > `CLAUDE_CODE_SESSION_ID`.

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
| browser | yes | `attach [--cdp port\|url]`, `frame --file [--url]`, `detach` (+ hooks: WebSearch results, WebFetch pages) | live CDP screencast of the most recently active tab (Electron main runs `core/cdp.ts`; frames go straight to the renderer, only status/url/title hit the reducer), or the latest pushed screenshot for non-CDP browsers. Local endpoints only; watch-only |
| settings | yes | — | global + session settings form |

## 5. Testing strategy

- **Unit (vitest)**: layout math, reducer, hook mapping (using real captured payloads), app
  reducers, protocol. `npm test`.
- **Integration (vitest)**: start the core server in plain Node on a temp home/runtime dir,
  drive it with the real CLI and `scripts/hook-forward.sh`.
- **Visual/E2E (Playwright `_electron`)**: `npm run e2e` launches Electron against a temp home,
  seeds it via the CLI/hook fixtures, and writes screenshots to `test/screenshots/`. Agents must
  *look* at them (Read the PNGs) after UI changes.
- **Plugin smoke test**: `claude -p --plugin-dir .` headless run with a temp `CLAUDE_GLASS_HOME`,
  glass open, verify state.json receives conversation/terminal/diff entries.

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
glass (hooks, bin on PATH, session binding, CLI all work).

### Post-MVP feedback round (2026-09-26)
- [x] Pin a window to its slot (title-bar pin button, `window pin/unpin`); others flow around it
- [x] Look less like real macOS: blue (not yellow) "move to front" light; darker, squarer dock,
      no magnify, bar-style running indicator
- [x] Dock auto-hide (global `dockAutoHide`): dock overlays, stage takes its space, 6px bottom
      hot zone reveals it
- [x] Dock order follows window order (global `dockOrder`: `windows` default, or `fixed` by type)
- [x] Dock: separators between desktops, apps on other desktops dimmed, 16px auto-hide hot zone
- [x] "Waiting on you" (one-way, never answerable in the glass): `session.waiting` set by
      PreToolUse AskUserQuestion / PermissionRequest / Notification(permission_prompt), cleared by
      the matching PostToolUse, UserPromptSubmit, Stop, SessionEnd. Amber presence pill with a
      summary, read-only question card under the top bar, lock on the held terminal row, edge glow
      (global `waitingGlow`, default on). PermissionRequest/Notification payload shapes are from
      docs, not captured yet: capture real ones into the fixtures file.
- [x] Live feed: guide tells Claude to bring what it's working on to index 0 and reorder by
      relevance (prose for now; a deterministic `focusOnUpdate` config is the fallback if prose
      isn't enough). Views always show the newest entry: terminal/conversation jump to bottom on a
      new entry (and stay there on resize), markdown append scrolls down, diff list/hunks reset
      to the newest revision.
- [x] Animated wallpapers: presets are a base gradient + bokeh layers drifting on long,
      staggered transform-only loops (47–71s). Global `animateBackground` (default on); off
      under prefers-reduced-motion. Image-path backgrounds stay static.

### Next candidates (not started)
Queue, in order:
1. [x] **Folder scope** (replaces `/clear` rebinding; `src/core/binding.ts`, done 2026-09-26). Global `scope`: `session` (default: one glass
   per session id; after `/clear` you get a fresh glass, `claude --resume` picks the old one back
   up) or `folder`: one glass per project folder, shared by every session in it, so `/clear`,
   restarts and resumes all land in the same glass. Folder glass id = `sha256(project dir)[:12]`,
   the same algorithm as Voice Multiplexer's relay session id, so the two ids match. Binding: the
   SessionStart hook symlinks `<runtime>/<session_id>.sock` → `<folder id>.sock`, so the hook
   forwarder and CLI keep addressing sockets by session id and need no lookup.
2. [x] **Image lightbox** (done 2026-09-26; see below).
3. [x] **Browser stream app** (done 2026-09-26). Any Chromium with a DevTools port
   (Playwright, Puppeteer, Chrome `--remote-debugging-port`) streams via CDP
   `Page.startScreencast`; anything else pushes screenshots with `frame --file`. The guide tells
   Claude to always run the browser headless so the glass is the only view of it. One-way: the
   glass never sends input to the page.

4. **Custom apps ("mods")**: drop a folder into `~/.claude/claude-glass/apps/` and it works.
   Design in §8. Not started.

Other candidates:
- `claude-glass install-cli`: link the CLI into `~/.local/bin` so it works in the user's own shell
  (plugin `bin/` is only on PATH inside Claude's Bash tool). Low priority: Claude is the main user.
- [x] Web research in the browser app (2026-09-26): PreToolUse WebSearch shows the query,
  PostToolUse lists results natively; PreToolUse WebFetch renders the page in a hidden offscreen
  Electron window (`src/main/webFeed.ts`: sandboxed, in-memory session, no popups/downloads/
  permissions, muted) and streams its paints. Latest activity wins between cdp/shot/web; a cdp
  navigation takes the screen back. Session setting `autoOpen.web`. Payloads captured in fixtures.
  History: every search/page in order (`history` + `cursor`, cap 100); ‹ › and a history list
  in the browser bar walk it (view-only `web.go`); new activity jumps back to the latest.
- Per-app storage files instead of one state.json; state size limits for huge sessions
- Packaged .app (electron-builder) so the dock shows "Claude Glass" instead of "Electron"
- Placeholder ghost slot while dragging; keyboard reorder
- [x] **Image lightbox**: clicking an image in the image viewer opens it as a full-window overlay with
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

Subagents app, per-app files instead of one
state.json, Linux support.

Ruled out (2026-09-26): user→Claude back-channel (breaks the one-way north star) and timeline
scrubbing (not the direction for this project).

## 8. Custom apps ("mods"): design (not started)

Goal: Claude Glass is an extensible framework with a few built-in apps. Anyone can write an app,
drop its folder in place, restart the glass, and it works, including instructions that tell
Claude how to use it. Simple, abstract, no special cases for built-ins.

**Feasible with this stack.** The app contract already exists (`AppDef` in core: pure
`init/command`; a view in the renderer). What's missing is loading apps at runtime instead of
compiling them in, and a view boundary that doesn't depend on our React build.

### A mod on disk
```
~/.claude/claude-glass/apps/<type>/
  glass-app.json   manifest: { type, title, icon, singleton, description, version,
                               commands: { name: { usage, help, view?: true } }, apiVersion: 1 }
  core.js          CommonJS, pure: exports { init(), command(state, cmd, args), onHook?(state, payload) }
  view.html        the view: any framework or none, self-contained (inline or relative assets)
  guide.md         optional: instructions for Claude, appended to the glass guide
```

### The two interfaces (the part that must be rock solid)
1. **Core (`core.js`)**: exactly today's `AppDef` minus the view: a pure reducer over the
   app's own state slice. Runs in Electron main (and plain Node for tests). Optional
   `onHook(state, payload)` gets every hook payload, so a mod can fill itself automatically
   (e.g. a test-results app watching `PostToolUse` Bash). It can't touch other apps' state.
2. **View (`view.html`)**: runs in a sandboxed iframe (like the html app, own origin, strict
   CSP, CDN scripts allowed) and talks over `postMessage` only:
   - glass → view: `{ kind: 'state', state, meta, size, theme }` on every change
   - view → glass: `{ kind: 'run', command, args }`, only for commands the manifest marks
     `view: true` (selection, paging: how things are viewed)
   Framework-agnostic, versioned (`apiVersion`), and a broken mod can't crash the glass. We ship
   a tiny optional helper (`glass-app.js`: `onState(fn)`, `run(cmd, args)`) and a starter template.

### One-way stays enforced by construction
Mods get no channel to Claude: the view can only run its own view commands, core only reduces
state. Claude drives a mod through the same CLI as any app: `claude-glass app <id> <cmd>`.

### Instructions for Claude
`claude-glass open` and SessionStart append each mod's `guide.md` (capped, e.g. 1.5 KB each)
under "Installed apps", and `catalog` lists mod commands. Authors control how Claude uses their
app without touching the core guide.

### Loading, errors, trust
- Loaded once at glass start (restart to pick up changes; hot reload later if wanted).
- Validate the manifest; reject type collisions with built-ins; a mod that throws is disabled
  and listed in Settings with its error. Other mods and the glass keep running.
- Trust: `core.js` runs in the main process with Node access, like any plugin you install.
  Say so in the docs. The view is sandboxed.
- Later: project-level mods (`<project>/.claude/glass-apps/`), `claude-glass apps install <git url>`.

### Dogfood
Port one built-in (html or image) to the mod format to prove the interface and serve as the
reference example. Built-ins may keep native React views, but register through the same loader.
