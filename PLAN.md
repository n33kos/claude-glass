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
claude-glass window tuck <id> <left|right|top|bottom> | untuck <id>
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

All apps except settings ship in the mod format (§8, `docs/apps.md`): views in sandboxed frames.

| App | Singleton | Commands | View |
|---|---|---|---|
| terminal | yes | `log --text`, `clear` | tool calls as terminal lines, collapsible output, type filter chips |
| conversation | yes | `clear` | chat bubbles, streaming |
| diff | no (`changes` auto) | `add --path --before --after` / `clear` | file tabs, flip ◀ ▶ through revisions |
| markdown | no (`plan` auto) | `set --text/--file`, `append` | rendered markdown |
| image | no (`images` auto) | `add --file [--caption]` | flip ◀ ▶ |
| html | no | `render --text/--file` | sandboxed iframe (`allow-scripts`, no same-origin) |
| browser | yes | `attach [--cdp port\|url]`, `frame --file [--url]`, `detach` (+ hooks: WebSearch results, WebFetch pages) | live CDP screencast of the most recently active tab (Electron main runs `core/cdp.ts`; frames go straight to the renderer, only status/url/title hit the reducer), or the latest pushed screenshot for non-CDP browsers. Local endpoints only; watch-only |
| settings | yes | — | global + session settings form, custom apps list (native: the shell's own UI) |

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
- [x] Pin a window to its slot (later removed: edge tucking replaced it)
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

4. [x] **Custom apps ("mods")** (done 2026-09-26): drop a folder into `~/.claude/claude-glass/apps/`
   and it works. Design in §8, author docs in `docs/apps.md`. Every built-in app except Settings
   ships in the mod format; `claude-glass apps [new|copy]`.
5. [x] **"Claude decides" layout** (done 2026-09-26; `fitLayout`, `guideFor`): a `defaultLayout` option (`claude`) where new desktops start
   with a fit for their window count (1 full, 2 split, 3 main-left, 4 grid) and the guide tells
   Claude to pick each desktop's layout for what it's showing (`claude-glass layout`).

6. [x] **Feedback round (2026-09-26)**: title bars show the title once (id in the tooltip);
   vertical scroll outside windows switches desktops (global `wheelDesktops`, default on;
   ⌘←/⌘→ too); every app can be turned off in Settings (global `disabledApps`: windows close,
   hooks leave it untouched via `withoutDisabled`, commands are refused with a clear error, it
   leaves the catalog and guide); `apps eject` renamed `apps copy`.
7. [x] **Browser highlight** (done 2026-09-26): Claude points at the passage it's relying on.
   `claude-glass app browser highlight --text "..."` stores the text on the current page entry;
   the glass's own page copy scrolls to it and highlights it (Electron `findInPage`, or Chromium
   text fragments `#:~:text=`, the "scroll to the quote" behavior from search results).
   As built: a self-contained script in the page copy finds the phrase across text nodes, marks
   it with the CSS Custom Highlight API (no DOM edits) and scrolls to it; match count shown. Claude
   decides when (the guide suggests: after reading a page, highlight the part you used). Not
   automatic from WebFetch: its result is a model's summary, not verbatim page text, so matching
   it would be unreliable. Pure one-way (Claude → glass). Kept in history, so going back shows
   the page with its highlight.
8. [x] **Browse the glass's copy of a page** (done 2026-09-26; host service `page-input`,
   browser app only; `web.away`/`web.home`, `homeSeq`): scroll, then click, in pages Claude
   fetched. North-star check: this drives only the glass's own offscreen copy, never Claude's
   browser, and nothing reaches Claude, so it's a viewing aid. The live Playwright/CDP stream
   stays watch-only (input there would interfere with Claude's browser). Scroll first (wheel
   over the frame → `sendInputEvent` on the offscreen page, via a host service); clicks second,
   with a clear "you're browsing, not what Claude read" state and a "back to Claude's page"
   button.
9. [x] **History mode** (tried and kept 2026-09-26; Settings → Windows & layout). After the first
   try: every action (each edit, plan, image, search, page) gets its own window, keyed by its
   tool call; default titles; browser is no longer a singleton and each on-screen browser window
   renders its own page (max 4 live, others keep their last frame); move/drag disabled.
10. [x] **Nested view** (tried and kept 2026-09-26): a global setting (`nestedView`), not a
    per-desktop layout. On: one spiral page, layout buttons hidden, `layout` refused with a hint,
    guide tells Claude index 0 is the big pane. Scroll over bars/gaps or ⌘↑/⌘↓ walks it.

11. [x] **Polish (2026-09-26)**: wallpaper drift ~2.5x faster and wider with a soft brightness
    pulse; Settings "All sessions" grouped under Sessions / Windows & layout / Look / Dock.

12. [x] **App permissions (2026-09-26)**: manifests may ask for `network` (explicit origins),
    `microphone`, `storage`; per-app CSP, sandbox `allow-same-origin` for storage, Permissions
    Policy + a locked session permission handler (Electron granted everything by default; now
    everything is denied except declared mic). Shown in Settings and `claude-glass apps`.

13. [x] **Edge tucking (tried and kept 2026-09-26)**: drag a window (or its dock icon) onto an
    edge's Tuck strip and it leaves the flow into that edge's slide-out panel (`state.tucked`,
    `window.tuck/untuck`); several split a panel; they stay mounted. Dock icons also drag to
    reorder; crowded docks shrink icons then scroll. Pinning later removed in favour of tucking.

14. [x] **Tuck polish (2026-09-26)**: pinning removed (tucking supersedes it); tuck strips 44px;
    a panel's inner-edge handle keeps it open and the layout insets to make room (`tuckKeep`);
    history mode ("New things Claude makes") is now a per-session setting; shell containers are
    `overflow: clip` so focus in the hidden dock or an edge panel can't scroll the glass.

15. [x] **Edge sidebars ("pin", 2026-09-26)**: tucking is called pinning in the UI and CLI
    (`window pin <id> <edge>` / `unpin`; state still `tucked`). A plain drag only reorders; drop on
    the pin target mid-edge (or ⌘-drag onto a strip) to pin; a kept-open sidebar takes drops
    anywhere over it, resizes from its inner edge (`tuckSize`), and side sidebars win over
    top/bottom. Hovering anywhere along an edge reveals it. Frames ignore the pointer during any
    drag. `claude-glass view` reports display modes, window positions and sidebars for Claude.

16. [x] **Sidebar dragging & polish (2026-09-26)**: drag to reorder within a sidebar, drag a
    window out of a sidebar to unpin it into that layout slot, placeholders everywhere; one
    chevron icon for every edge's keep-open handle; the hidden sidebar's pull is a black
    "camera bevel" rail that eases off the edge and stretches the drawer's length when it opens
    (a label, not a target); with the dock on auto-hide the bottom edge is shared (dock in the
    middle, bottom sidebar either side). New layout `main-left-nest` (one big, two small, with
    the bottom-right small split again).

17. [x] **Sidebar pull v2 + history cap (2026-09-26)**: opening a sidebar turns its rail into a
    solid black backing along the screen's whole edge, and the capsule rides to the sidebar's
    inner edge as the keep-open chevron. With the dock on auto-hide, the closed bottom capsule
    sits centered above the dock trigger and fades while the dock is up. `.stage` clips (hidden
    still scrolled when a tucked frame took focus). History mode keeps the newest
    `session.historyLimit` history windows (default 12; pinned ones spared).

18. [x] **Custom background colors (2026-09-26)**: global `backgroundColors` (up to 4 hex; Settings
    → Look pickers, "Use preset" clears) recolor the wallpaper light over any preset (and over an
    image). Claude's signal is per session: `claude-glass background --colors ... | reset`
    (`settings.backgroundColors`, hex-validated in the reducer); the guide says what colors mean.
    Blob colors are a registered `@property --bokeh`, so changes ease over 1.6s.

19. [x] **Tool reminders (2026-09-26)**: a PostToolUse Bash hook (`scripts/tool-reminder.sh`,
    synchronous but instant) adds a reminder to Claude's context when a command read or wrote
    files through the shell (cat/sed/head at command start, `sed -i`, grep context dumps,
    heredocs, `python -c`, redirects into files) while a glass is open: use Read and Edit/Write
    so the glass can show the work. Never blocks. git and claude-glass commands are skipped
    (prose arguments). Global `toolReminders` (default on) turns it off.

20. [ ] **Stability (2026-09-27, in progress)**: WindowServer watchdog hangs (system froze and
    restarted) while the glass ran next to Alchemy (Electron, WebGL). Found: backdrop blur on every
    window, the top bar and the dock re-ran each frame over the live wallpaper (glass GPU process
    ~41% of a core → ~19% without; drift itself is cheap). Blur removed from always-on surfaces.
    Tests now keep their own Chromium profile and stay out of the dock. Every glass process shared
    one Chromium profile at once, which Chromium doesn't support (cookie/storage corruption risk);
    now each glass keeps its own profile (`userData/glasses/<glass id>`), seeded once from the old
    shared profile's cookies and storage so pairings survive. Separate processes stay the design.
    Missing dock icon / ⌘Tab: Claude runs inside tmux, outside the user's GUI session, so a glass
    spawned as its child got windows but no dock tile or ⌘Tab (System Events couldn't see it).
    The launcher now starts the packaged app through LaunchServices (`open -n -a … --env … --args`).
    Later: prune profiles of glasses long gone.

23. [x] **Images grid (2026-09-27)**: the images app's corner button (or `view --mode grid|single`,
    saved with the window) shows the 12 most recent images as a grid, newest first; a tile opens
    that image alone. App guides can now depend on settings: `<!-- when windowMode=live -->` …
    `<!-- end -->` blocks in `guide.md` (`guideForSettings`; keys `windowMode`, `nestedView`). The
    images guide asks Claude to reuse one viewer (`show … --id images`) in live mode only. Fixed on
    the way: built-in apps' `guide.md` was never read (only custom apps' was).

24. [x] **App settings (2026-09-27)**: manifests declare `settings` (key → type bool|enum|number|
    color|text, label, default, help, min/max/options; `parseSettingSpecs`). Values are global
    (`appSettings.<type>`), set with `claude-glass settings set app.<type>.<key> <value>` (validated
    by `coerceSetting`), listed by `claude-glass settings`, shown under each app in Settings → Apps,
    passed to views as `props.settings` (defaults filled in), and usable in `guide.md` when-blocks by
    key. Example: images `gridSize`. Docs in `docs/apps.md`.

25. [x] **State palettes (2026-09-27)**: global `stateColors` (default on) + `statePalettes`
    recolor the wallpaper light from session state the hooks already track (`moodOf`): working
    (default: the user's own light), waiting on the user (amber), done/your turn (green), ended
    (graphite). Editable per state in Settings ("Tint" / "Use mine"). No error state: failed
    commands are too common to be a signal. Precedence (`lightColors`): Claude's `background`
    one-off, then the state palette, then the user's own, then the preset's. The guide's signal
    paragraph is gone (context saved); one optional `background` line remains in the command list.

21. [x] **Selectable panes (2026-09-27, trying it)**: global `selectToInteract` (default on). Layout
    windows that aren't selected get a clear `.body-shield` over their body: the wheel over it walks
    desktops (or the nested spiral), and a click selects the window (blue ring, shield gone, content
    live). Clicking anywhere else or Esc deselects. Sidebar windows stay live. Selection is
    view-only UI state (a tiny store in App.tsx), never reducer state. Risk: the extra click may
    frustrate; judge in use, the setting turns it off.

22. [x] **"Watch" view (2026-09-27, first cut)**: a style of the nested view (global
    `nestedStyle: spiral | watch`, Settings → Nested view → Arrangement). The focused window sits in
    the middle; the next four older windows fill a 2×2 grid on the right (near column larger), the
    four newer ones on the left; farther ones wait just past the edges, hidden, and slide in.
    Tiles are the real window laid out at full size and scaled down (`Placed.scale`), so they read
    as zoomed-out copies and grow smoothly into the middle. Scroll (either direction) or ⌘←/⌘→
    walks the row; clicking a tile brings it to the middle. Ideas: more depth rings, a subtle
    perspective/blur on far tiles.

26. [x] **Resizable windows inside a sidebar (2026-09-27)**: drag the gap between two windows in a
    sidebar (`.edge-split`) to change their shares; `tuck.split` stores normalized shares per
    sidebar (`tuckSplit`), each window keeps at least 90px, and the shares are ignored (even split)
    once the sidebar's window count changes.

27. [x] **Top bar in macOS fullscreen (2026-09-27)**: the window's `enter-full-screen` /
    `leave-full-screen` events (`glass:fullscreen`) put a `fullscreen` class on the page, and the top
    bar drops the traffic-light inset. (Comparing window and screen size fails on notched Macs.)
    Hiding the bar entirely stays an option if the shifted bar still feels wasted.

Other candidates:
- [x] **Custom app icons** (2026-09-26): an app can ship an image icon (e.g. `icon.svg`/`icon.png` in its folder,
  or `"icon": "icon.svg"` in the manifest) used in the dock and title bar instead of a glyph;
  glyphs stay the fallback. Built-ins could get proper icons too.
- [x] Web research in the browser app (2026-09-26): PreToolUse WebSearch shows the query,
  PostToolUse lists results natively; PreToolUse WebFetch renders the page in a hidden offscreen
  Electron window (`src/main/webFeed.ts`: sandboxed, in-memory session, no popups/downloads/
  permissions, muted) and streams its paints. Latest activity wins between cdp/shot/web; a cdp
  navigation takes the screen back. Session setting `autoOpen.web`. Payloads captured in fixtures.
  History: every search/page in order (`history` + `cursor`, cap 100); ‹ › and a history list
  in the browser bar walk it (view-only `web.go`); new activity jumps back to the latest.
- [x] **Virtualize far windows** (2026-09-26): windows far from what's on screen (other desktops, deep
  in the nested spiral) keep their frame but don't mount their app view; they mount when they come
  near. Keeps history mode fast without storage limits (no caps on history for now; revisit if
  state.json gets heavy).
- [x] Packaged .app (2026-09-26): `scripts/make-app.mjs` (macOS, part of `npm run build`) clones
  Electron.app to `dist/Claude Glass.app` (APFS clone), renames it, swaps in our icon, re-signs ad
  hoc; the launcher prefers it. No new dependency. Dock/menu bar say "Claude Glass".
- [x] Placeholder ghost slot while dragging (2026-09-26): a dashed slot shows where a dragged window
  lands, in the layout and inside sidebars (the sidebar's windows reflow around it).
- [x] **Custom background colors** (2026-09-26; see 18).
- [x] **Image lightbox**: clicking an image in the image viewer opens it as a full-window overlay with
  wheel/pinch zoom and drag to pan; Esc (or clicking the backdrop) closes it. Renderer-only
  (view state, no reducer action), so it's small. Good for small screenshots and diagrams.
- **Thoughts app** (skipped 2026-09-26 by the user's call; kept for the record): list Claude's thinking. No hook
  carries thinking (the captured `MessageDisplay` payloads only have visible text), so the only
  source is the session transcript JSONL, whose path (`transcript_path`) arrives in every hook
  payload. Idea: on `Stop` (and maybe `PostToolUse`), have core read new transcript lines from
  a saved byte offset and push `thinking` blocks into a singleton `thoughts` app. Open questions:
  whether transcripts hold readable thinking or only redacted/signature blocks, and whether
  reading the transcript counts as the "no transcript tailing" rule from §3. Check a real
  transcript before building anything.
  **Checked 2026-09-26** (a real 23 MB session transcript): 220 of 250 thinking blocks are empty
  (signature only); the other 30 are short one-line summaries (~150-230 chars), not the reasoning
  itself. So a thoughts app would be sparse. If wanted, the cheapest honest version is faint
  "thinking: …" lines in the conversation app, read from the transcript on Stop from a saved byte
  offset (this does bend the "no transcript tailing" rule). On hold pending the user's call.

## 6b. History mode (built and kept; see item 9)

Idea: instead of updating one "changes"/"plan"/"images"/"browser" window in place and
reordering, every new thing Claude produces opens a **new window**. Because new windows already
insert at slot 0 and older ones spill onto later desktops, scrolling right becomes scrolling
back in time: a running visual log of the session.

Risk: this touches how hooks pick instances, window counts grow without bound, and it could
feel noisy. The user wants to try it and back it out cleanly if it isn't good, without raising
cyclomatic complexity. So:

- **One seam, no new branches in the reducer or layout.** Hooks already call `autoCommand` with
  a fixed instance id (`changes`, `plan`, `images`, `browser`). History mode replaces that id
  choice with one function, `targetId(kind, state, mode)`: `live` mode → the fixed id (today);
  `history` mode → a fresh id per event (e.g. `changes-17`), created open at slot 0. Everything
  else (layout, desktops, dock, persistence, views) is unchanged.
- **Granularity:** one window per event is too many for diffs (every Edit). Start with one per
  *turn* per kind: all edits in a turn land in that turn's "Changes" window; the next turn opens
  a new one. `turn_id` is in the hook payloads.
- **Bound it:** far windows are virtualized, and (2026-09-26, it got out of hand fast) history
  windows are capped at `session.historyLimit` (default 12), oldest deleted first, pinned spared.
- **Singletons stay live:** conversation and terminal are already running logs.
- **Setting:** global `windowMode: 'live' | 'history'` (default live). Off = exactly today.
- **Try it on a branch** (`experiment/history-mode`), use it for real sessions, then decide:
  merge, adjust, or delete the branch. No partial merges.

## 6c. Nested view (built and kept as a setting; see item 10)

Idea: one screen, no desktops. The newest window takes the biggest pane (half the screen); each
older one gets half of what's left, alternating direction (a spiral of ever-smaller panes), so
history recedes into deeper and deeper subdivisions. Scrolling walks the focus: scroll down and
every window steps up one level (the next-older one becomes the big pane); scroll up steps back.
Pairs naturally with history mode but also works with today's live windows.

Keep it contained:
- **It's just a layout.** Add `nested` to the layouts, computed by one pure function
  `nestedRects(count, focus)` next to `computeDesktops`: a nested desktop takes every window, so
  there is only one page. No reducer or app changes.
- **Focus is view state:** `ui.focus` (like `ui.viewingDesktop`), set by the wheel instead of
  switching desktops while this layout is active; Claude's `window move <id> 0` still works.
- **Bound the depth:** past ~6 levels panes are too small to read; the rest collapse into one
  "+N older" tile you scroll into.
- **Animate** pane moves with the existing transform transitions so the recession reads.
- Same rule as history mode: try it on a branch, keep it only if it feels good.

## 7. Future ideas (not MVP)

Subagents app, per-app files instead of one
state.json, Linux support.

Ruled out (2026-09-26): user→Claude back-channel (breaks the one-way north star) and timeline
scrubbing (not the direction for this project).

## 8. Custom apps ("mods"): design (built 2026-09-26)

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

### As built
- Loader `src/core/mods.ts`; registry `registerApp`; `app.hook` reducer action runs `onHook`.
- Views: `glass-app://<type>/` protocol + `FrameView` host + SDK (`src/sdk/glass-app.ts`,
  `glass-app.css`, React adapter `react.tsx`). Host services: `lightbox`, `aspect`. Frames:
  `frame` messages. Windows render in a stable DOM order so frames never reload on reorder.
- Built-ins compile to complete mod folders in `dist/apps/<type>` (core.js, generated
  manifest, view.html/js/css, sources in `src/`); main attaches them before user mods load.
- Settings stays native: it is the shell's own configuration UI (global config + session
  settings), not content. It lists custom apps and load errors.
- Guide: built into core (`src/core/guide.ts`), served by the glass (`guide` op) so it includes
  each app's `guide.md`.

### Dogfood, then go all the way
1. Port one built-in (html or image) to the mod format to prove the interface and serve as the
   reference example.
2. Once proven, move **every** default app to the mod format and loader: they ship as mods in
   the plugin (`apps/` next to `src/`), loaded exactly like user mods. The mod interface becomes
   the primary, first-class way apps exist, and users can copy and modify a default app (a user
   mod with the same `type` overrides the shipped one, with a note in Settings).
3. Consequence to plan for: views move from native React to iframes. Check that terminal and
   conversation (high update rates, big lists) stay smooth over postMessage; send state diffs or
   batch updates if not.
