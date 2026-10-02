# Claude Glass

Claude's monitor. Claude Glass is a desktop window bound to a Claude Code session that works like
a screen share from Claude to you. As Claude works, the window fills itself: the conversation,
every tool call it runs, diffs of every file it edits, its plans, the images it looks at, and the
web pages it reads. When Claude wants to *show* you something, like a chart, a mockup, a
comparison or a write-up, it puts it on the glass with one command.

It's built for working with Claude like a coworker, especially by voice, when you can't easily see
what Claude sees. It is primarily one-way: Claude shows, you watch.

*Why "Claude Glass"?* A [Claude glass](https://en.wikipedia.org/wiki/Claude_glass) was an
18th-century tinted mirror that painters and travelers used to look at a scene through glass,
named after the painter Claude Lorrain. This one lets you look at Claude's work the same way.

![A glass mid-session: Claude's chart, its plan, the diffs, the conversation and the terminal](docs/media/overview.png)

- [Install](#install)
- [Using the glass](#using-the-glass)
- [What Claude can do with it](#what-claude-can-do-with-it)
- [Settings](#settings)
- [Custom apps](#custom-apps)
- [How it works](#how-it-works)
- [Develop](#develop)

## Install

Requirements: macOS, Node 20+, and Claude Code 2.1.287 or newer with
[mods](https://code.claude.com/docs/en/plugins/mods/overview) allowed. The glass is fed by a small
mod the plugin ships (`hooks/glass-mod.ts`); if mods are off (`disableAllHooks`, or an
organization's policy), `claude-glass open` says so.

**From the plugin marketplace** (in Claude Code):

```
/plugin marketplace add n33kos/claude-plugins
/plugin install glass@n33kos
```

The plugin is named `glass`: Claude Code reserves plugin names starting with `claude-` for
Anthropic's own. Everything else (the `claude-glass` command, the app, `~/.claude/claude-glass`)
keeps its name. Installed it earlier as `claude-glass@n33kos`? Uninstall that and install
`glass@n33kos`.

**From a clone:**

```sh
git clone https://github.com/n33kos/claude-glass ~/claude-glass
claude --plugin-dir ~/claude-glass     # try it for one session
```

The first `claude-glass` command installs and builds the app (`npm install && npm run build`,
a minute or two, once). The mod does nothing until then, so Claude is never held up.

**Updating:** after `/plugin update`, sessions that started earlier still have the old version's
`claude-glass` on their PATH; it hands every command to the installed version, so they open and
drive the new one without a restart. A glass already running an older version shows a
**Restart** pill in its top bar that reopens it in the new version, windows and history kept.
The version a glass runs is in the top bar's right corner (`dev` when it runs from a checkout).

## Using the glass

Ask Claude to "open the glass", run `/glass:glass`, or from a shell inside the session:

```sh
claude-glass open      # this session's glass ($CLAUDE_CODE_SESSION_ID)
claude-glass close
claude-glass status    # every glass, open or closed
claude-glass health    # this glass's memory and CPU since it opened, and any crashed processes
```

Each glass keeps a small health log (`metrics.ndjson` in its session folder): a sample every five
minutes of what its processes use, and a line whenever one crashes, so a slow leak or GPU trouble
can be traced after the fact.

To open one automatically for every session, turn on **Open Claude Glass when a Claude session
starts** in Settings (the gear in the launcher), or `claude-glass settings set autoStart true`.

**What fills in by itself** (no Claude tokens spent):

| Window | Shows |
|---|---|
| Conversation | your prompts and Claude's replies, streamed |
| Terminal | every tool call with its output, filterable by tool; a lock on the one waiting for you |
| Changes | a diff of every edit; flip through a file's revisions |
| Plan | plan files and plan mode |
| Images | one window for every image Claude reads or shows (one at a time or a grid; "Show in Finder" reveals the original), and a Project tab with the images in the project folder, newest first |
| Browser | Claude's web searches (results) and the pages it fetches, rendered, with back/forward and the passage Claude says it relied on highlighted; a browser Claude drives (Playwright, Chrome with a DevTools port) streams in live, watch-only (copy the address or open it in your own browser with ↗) |
| Tasks | Claude's own to-do list, live, with progress and what it's doing now |
| Agents | the subagents Claude starts: their task, whether they're still running, and what each reported |
| Action | permission prompts you can answer from the glass (Allow, Always allow, Deny); comes to the front when Claude needs you, goes once answered |
| Tests | results of the test runs Claude does (npm test, vitest, jest, pytest, go test, cargo test…): pass/fail, failing tests, recent runs |
| Files | every file Claude read or changed: most recent first, or as a folder tree; click a changed file to see its diff in Changes |

Claude can also draw **diagrams** from templates (flow, sequence, layers, timeline, compare, tree,
cycle, stats): it picks one and fills it with JSON, so they look the same polished way every time.

**Arranging windows.** Windows form one ordered list, newest first. They tile into desktops, each
with a layout (full, side by side, one big and two small, a nested variant, three columns, grid);
overflow spills onto the next desktop.

- Switch desktops with ⌘←/⌘→, a sideways swipe, or scrolling over the gaps.
- **Select to interact** (on by default): click a window to use it (it gets a blue ring); scrolling
  over any other window switches desktops. Click elsewhere or press Esc to let go.
- Drag a title bar to reorder; a dashed placeholder shows where it lands. Hold it at a side edge to
  move it to the next desktop.
- **Docks**: drag a window (or its launcher icon) onto a dock target, in the middle of a screen
  edge or in a corner, to dock it there. A closed dock is a small capsule of its apps' icons; hover
  the edge (or corner) and click to open it, or set docks to open on hover. Docked windows float on
  the wallpaper like any window. Hover an open dock and a lock on its inner edge keeps it open (or
  releases it); kept open, the layout makes room, and a dock that slides out on hover comes over
  kept ones. Drag its inner edge to
  resize it (a corner dock resizes both ways from its inner corner), the gap between two of its
  windows to share it differently, and a window out of it to undock. Corner docks suit apps that
  want a fixed, modest size: a kept corner takes the end of its side's column and the edge dock
  fits beside it. Docked windows stay put on every desktop, which suits things you interact with.

  ![The terminal docked at the right edge, kept open beside the desktop](docs/media/sidebar.png)
- **Nested view** (Settings): one screen instead of desktops. *Spiral*: the newest window is big
  and each older one takes half of what's left. *Carousel*: the focused window sits in the middle
  and its neighbors line up as small tiles either side; scroll, swipe or click a tile to move
  along.

  ![The carousel: scrolling moves the next window into the middle](docs/media/carousel.gif)
- **History mode** (Settings, per session): every edit, plan, image, search and page opens in its
  own window, newest first, so the glass reads as a timeline (the newest 12 are kept).
- **Presets**: save a glass's frame (which apps sit in which docks, their sizes and splits,
  desktop layouts, this glass's settings and the look) under a name and a short description, then
  apply it to any glass, or make it the frame every new glass starts with. In Settings, or
  `claude-glass preset save|apply|list|default`, and `claude-glass open --preset <name>`. Claude sees
  the list with descriptions, so "set up the glass for this" can pick one. Presets are JSON files in
  `~/.claude/claude-glass/presets/`, easy to edit or share.
- **Launcher** (the bar along the bottom): the open windows, with each app's own icon. Click to
  show one, drag to reorder, drag onto a dock target to dock it. An app's windows share one icon
  with a count; click it to pick one (turn grouping off in Settings for an icon per window). The
  **Apps** button beside Settings shows every app that isn't on screen: a count means closed windows
  (hover to pick one to reopen), and a click reopens the latest or starts the app. It can
  auto-hide.
- **Sign-ins follow you**: pages an app embeds (like vmux's relay) keep their sign-in in one shared
  place, so a new glass starts signed in.
- **Look**: Graphite Mono, a neutral frame with no hue, so the only color on screen means
  something ([docs/design.md](docs/design.md)). Dark or light (or follow macOS). Wallpaper presets or
  your own image, and your own light colors.
- **Signals**: the wallpaper light is how the glass points and reports. Amber rises while Claude
  waits on you, a green bloom when a long turn is done, red behind a window that broke (a failing
  test run), blue behind a window Claude wants you to look at, and a hairline bar for long work.
  One at a time, and each fades back to graphite. Claude sends its own with `claude-glass signal`.
- **Attention on its own**: in Settings → Attention, choose what the glass does when an edit,
  plan, failing test run, web page, image or subagent comes in: light its window, bring it to the
  front, or both. It happens every time, without Claude having to remember. While Claude works on
  a turn, a thin white bar runs along the bottom (`turnProgress`); a turn has no known end, so it
  sweeps, and fills by tasks done only while Claude works through a task list. The green bloom and a
  red light on the conversation (a turn that died on an error) come from how the turn really ended.
- **Waiting on you**: when Claude asks a question or needs a permission, the top bar says so, a
  read-only card shows the question, and the edges glow. You answer in Claude Code, as always.
- **Approve from the glass** (the Action app, the one built-in two-way app): when Claude Code
  asks your permission, a card comes to the front with what Claude wants to do and Allow, Always
  allow and Deny. The same choices show above the prompt in the terminal (1–4), and whichever you
  answer first decides; "Ask here instead" falls back to Claude Code's own prompt. Nothing but the
  glass's own window can answer (not the CLI, not Claude). Turn it off in Settings → Apps →
  Action. An experiment there, off by default, does the same for Claude's own questions
  (AskUserQuestion): options as buttons, or your own words. Sessions that start with a glass open
  also give Claude a `glass` ask tool, for questions that are easier answered looking at the glass
  ("which of these mockups?").
- **Point and ask**: "Ask about this" on a change in Changes, Ask on a terminal entry, or a
  selection in a markdown window (the plan) attaches it to your next prompt (a chip in the top
  bar; × takes it off); Claude reads it with what you say. Opt-in extras in
  Settings: Stop (`interruptButton`: the "Claude is working" pill turns into a stop button on
  hover) and an Ask Claude field in the header (`askBox`). Conversation always has a message box
  at the bottom: what you type goes to Claude as your prompt (once it's free), with anything you
  attached shown as chips above it.

  ![Claude asked a question: the top bar, a read-only card, and amber light](docs/media/waiting.png)

## What Claude can do with it

The plugin gives Claude a short guide when a glass is open (`claude-glass help` prints it) and the
`claude-glass` CLI:

```
claude-glass view                          what's on screen: desktops, windows and their positions, docks
claude-glass show <file> [--id ID]         .md → markdown, image → image, .html → html; opens first
claude-glass new <type> [--id ID] [--title T]
claude-glass app <id> <command> [--text T | --file F] [--key value]
claude-glass window open|close|delete <id>
claude-glass window move <id> <index>      0 = the first slot, to bring something to your attention
claude-glass window dock <id> <place> | undock <id>   place: left|right|top|bottom|top-left|top-right|bottom-right|bottom-left
claude-glass layout <desktop#> full|split|main-left|main-left-nest|columns|grid
claude-glass catalog                       every app and its commands
claude-glass settings [set <key> <value>]  (Claude changes settings only when you ask)
claude-glass preset list | apply <name>     your saved frames, with descriptions
claude-glass signal spotlight|alert <window> | progress <0..1> [--label L] | clear
claude-glass background --colors "#hex,…" | reset
```

Claude is told to treat the glass as a live feed of its focus: bring what it's talking about to
the first slot, keep related things together, and pick a desktop layout that fits what it shows.
HTML canvases run sandboxed (scripts from a few CDNs allowed, no network), so Claude can draw
charts and diagrams.

## Settings

Everything is in Settings (the gear in the launcher), and `claude-glass settings` lists it all with
the current values. Global settings live in `~/.claude/claude-glass/config.json`.

<img src="docs/media/settings.png" alt="Settings: light colors and state colors" width="560">


| Key | Values | What it does |
|---|---|---|
| `autoStart` | true / **false** | open a glass when a Claude session starts |
| `scope` | **session** / folder | one glass per session, or one per project folder (see below) |
| `defaultPreset` | a preset name / **none** | the frame every new glass starts with |
| `nestedView` | true / **false** | one screen instead of desktops |
| `nestedStyle` | **spiral** / carousel | how the nested view arranges windows |
| `defaultLayout` | claude / full / split / main-left / main-left-nest / columns / **grid** | layout for new desktops; `claude` lets Claude pick |
| `selectToInteract` | **true** / false | click a window to use it; scrolling over the others switches desktops |
| `wheelDesktops` | **true** / false | scrolling outside windows switches desktops |
| `windowOpacity` | 0.2–1 (**0.78**) | window glass opacity |
| `background` | aurora / dune / tide / **graphite** / an image path | wallpaper (light theme uses its own pale one) |
| `backgroundColors` | up to 4 hex colors | your own wallpaper light (empty: the preset's) |
| `animateBackground` | **true** / false | drift the wallpaper light |
| `theme` | **dark** / light / system | the glass's theme |
| `signals` | **true** / false | the signal layer: the light points at windows and shows done, failed, progress |
| `stateColors` | true / **false** | the whole light also follows the session (the signal layer says the same, more precisely) |
| `statePalettes` | JSON per state | colors for working / waiting / idle / ended (`[]`: your own) |
| `waitingGlow` | **true** / false | amber edge glow while Claude waits on you |
| `signalDone` | **true** / false | a green bloom when a long turn is done |
| `followEdits`, `followPlans`, `followWeb`, `followImages`, `followAgents` | **off** / light / front / both / focus | when an edit, plan, search or page, image, or subagent comes in: light its window, bring it to the front, both, or both and show desktop 1. Only windows on screen move |
| `followTests` | off / **light** / front / both / focus | the same when a test run fails (lit red) |
| `interruptButton` | true / **false** | two-way: while Claude works, the status pill stops the turn when clicked (like Esc); hovering shows a red stop square |
| `viewContext` | true / **false** | each prompt tells Claude what's on the glass now (so it ranks windows from what's really there; costs tokens) |
| `askBox` | true / **false** | two-way: an Ask Claude field in the header, beside Conversation's own message box; what you type is sent as your prompt (once Claude is free) |
| `contextGauge` | **true** / false | how full Claude's context window is, in the top bar (hover: tokens, cost, plan limits; amber near full) |
| `turnProgress` | **true** / false | a thin white bar along the bottom while Claude works: it sweeps, brightens on each model request, and fills by tasks done when Claude works through a list |
| `dockOpen` | **click** / hover | a hidden dock opens when its tab is clicked, or on hover |
| `launcherAutoHide` | true / **false** | hide the launcher until the pointer reaches the bottom (was `dockAutoHide`) |
| `launcherOrder` | **windows** / fixed | launcher follows window order, or a fixed order by app (was `dockOrder`) |
| `launcherGroup` | **true** / false | an app's windows share one launcher icon, with a list to pick one |
| `disabledApps` | app types | turned-off apps are hidden and Claude can't use them |
| `toolReminders` | **true** / false | remind Claude to read and edit with its own tools (so you see the work) |
| `app.<type>.<key>` | per app | an app's own settings (e.g. `app.image.gridSize`) |

Per session (`claude-glass settings set session.<key> <value>`): `windowMode` (live / history),
`historyLimit`, `autoOpen.changes|plan|images|web`, `windowOpacity`.

**Scope.** `session` gives each Claude session its own glass; after `/clear` you start fresh and
`claude --resume` picks the old one back up. `folder` gives each project folder one glass that
every session in it feeds, so `/clear`, restarts and resumes continue in the same window. A folder
glass's id is `sha256(project dir)[:12]`.

## Custom apps

Every window is an app, and the built-in ones use the same format anyone can: a folder with a
manifest, a small pure `core.js`, and a `view.html` that runs in a sandboxed frame.

```sh
claude-glass apps new my-app      # scaffold ~/.claude/claude-glass/apps/my-app
claude-glass apps copy markdown   # start from a built-in
claude-glass apps                 # what's installed (and what failed to load, and why)
```

```
~/.claude/claude-glass/apps/my-app/
  glass-app.json   type, title, icon, commands, permissions, settings, stored values
  core.js          init() and command(state, name, args): pure state; optional onEvent(state, event)
  view.html        the view; loads the SDK and renders props
  guide.md         instructions for Claude (optional)
  icon.svg         launcher and title bar icon (optional)
```

An app can fill itself from the session's events (`onEvent`), take commands from Claude
(`claude-glass app <id> <command>`), declare its own settings (shown in Settings, passed to the
view), keep **stored values** the glass saves for it (per session, per project folder, or for
every glass, shared live between glasses), and ship instructions for Claude, with parts that
depend on settings. Views are sandboxed
with no network, microphone or storage unless the manifest asks for specific origins or
capabilities, which Settings shows. Full guide: [docs/apps.md](docs/apps.md).

## How it works

```
Claude Code session
  ├─ the glass mod (hooks/glass-mod.ts) ── `claude-glass event` ─────────┐
  └─ Bash tool: `claude-glass <cmd>` (bin/ on PATH) ─────────────────────┤ Unix socket
                                                                         ▼
                  ┌──────────── Electron main process (one per glass) ────────────┐
                  │  core/server.ts   Unix socket, one JSON request per connection │
                  │  core/reducer.ts  every state change is one reducer action     │
                  │  core/events.ts   session events → actions                     │
                  │  apps/*           app cores (pure: init, command, onEvent)     │
                  └────────────▲──────────────────────────────┬─────────────────────┘
                      ipc: dispatch(action)            ipc: state patches
                  ┌────────────┴──────────────────────────────▼─────────────────────┐
                  │  renderer (React): desktops · windows · launcher · docks         │
                  │  app views in sandboxed frames (glass-app://<type>/view.html)    │
                  └──────────────────────────────────────────────────────────────────┘
```

**Principles**

- **A small core anyone could drive.** State, one reducer, and newline-delimited JSON over one Unix
  socket per glass. The CLI is a thin client; you could drive a glass with `nc -U`. Electron is
  just the renderer. The core (`src/core`, app cores) is plain Node/TypeScript and runs in tests
  without Electron.
- **One process per glass.** No hub or shared server. Each glass has its own Electron process,
  socket, window and browser profile, so a crash affects one glass.
- **Same actions for everyone.** A drag in the window and a command from Claude go through the same
  reducer action. Commands are relative ("move X to the first slot"), so Claude never overwrites
  your arrangement, and it never changes which desktop you're looking at.
- **CLI first, no servers.** The mod, you and Claude all drive a glass the same way: the
  `claude-glass` CLI over the glass's Unix socket. Nothing else runs in the background.
- **Deterministic first.** Anything the session's events can show appears automatically, at no
  token cost. Claude only spends effort on deliberate "let me show you this" moments.
- **Off means off.** With no glass open, the mod doesn't even run the CLI (it checks for the
  socket) and nothing is recorded. Reopening a glass restores its history.
- **Never block Claude.** The mod hands events over in the background, in order; a slow or
  frozen glass can't hold Claude up.
- **Primarily one-way.** Your interactions change how things are viewed (layout, what's selected,
  which revision is shown) and don't reach Claude. Every workflow (terminal, tmux, voice, IDE)
  takes input differently, so anything that does talk back will be an app's opt-in permission,
  never part of the core.

**Protocol.** One JSON line per connection: `{"op": …}` → `{"ok": true, "result": …}` or
`{"ok": false, "error": …}`. Ops: `ping`, `event` (session events from the mod), `dispatch` (a
reducer action), `view`, `state`, `catalog`, `guide`, `mods`, `config`, `quit`.

**The mod → the glass.** The mod (`hooks/glass-mod.ts`) runs inside Claude Code and turns the
session's events into glass events (`src/core/events.ts`): `turn.start` (your prompt), `text` (the
reply as it streams), `tool.start`/`tool.end` (the terminal and, per tool, the Changes diffs, the
Plan, Images, the Browser, Tasks, Agents, Tests, Files), `permission` and AskUserQuestion ("waiting
on you"), `turn.complete`, `agent.end`, `session.start`/`session.end`. At each session start it runs
`claude-glass session-start`, which opens the glass (if `autoStart`), and it gives Claude the guide
with the first message of each conversation; when your settings change the guide, the next prompt
carries the new one. It also reminds Claude to read and edit with its own tools when a Bash command
did file I/O (`toolReminders`). Events go out in order, a batch per CLI call. Auto-created windows
open once; if you close one, it stays closed. Apps with `onEvent` see every event too.

**The glass → the session** (opt-in, two-way): every prompt passes through the glass while one is
open (`claude-glass hook prompt.submit`: what you attached, the guide when it changed, two-way
apps' hooks); the tool calls two-way apps hook do too (`claude-glass hook tool.call`). Permission
prompts and questions wait on `claude-glass action wait`, and the Stop button and the Ask box on
`claude-glass watch`: CLI calls that block on the socket until there's an answer. Nothing else
runs; nothing on the socket can approve anything (only the glass's own window).

**State.** A glass is one `GlassState`: the session (activity, what it's waiting on), the ordered
window list, per-desktop layouts, window instances, each app's own state slice, docks, and
per-session settings. It's saved (debounced) to `state.json`, and the renderer gets patches.

**Launching.** `claude-glass open` starts the app through macOS LaunchServices (a renamed copy of
Electron, `Claude Glass.app`), so it has its own dock icon and ⌘Tab entry even when Claude runs
inside tmux, and waits until the socket answers. Every installed version shares one bundle,
`~/.claude/claude-glass/app/<electron version>-<icon hash>/Claude Glass.app`, built once: macOS ties
the microphone grant to the app, so updates don't ask again (only an Electron upgrade does).

**Files**

```
~/.claude/claude-glass/config.json                   global settings
~/.claude/claude-glass/apps/<type>/                  custom apps
~/.claude/claude-glass/sessions/<id>/state.json      a glass's saved state
~/.claude/claude-glass/sessions/<id>/files/          copies of images shown on it
~/.claude/claude-glass/sessions/<id>/glass.log       app log
~/Library/Application Support/Claude Glass/glasses/<id>/   a glass's browser profile
/tmp/claude-glass-<uid>/<id>.sock                    a live glass's socket
/tmp/claude-glass-<uid>/<session>.sock               folder scope: link to the folder glass's socket
```

`<id>` is the session id, or the folder id in folder scope. Sockets live in `/tmp` because macOS
limits socket paths to 104 bytes. `CLAUDE_GLASS_HOME` and `CLAUDE_GLASS_RUNTIME` move the first
two groups (tests use temp folders).

## Develop

```sh
npm install
npm run build       # esbuild → dist/ (CLI, main, preload, renderer, built-in apps) + the shared Claude Glass.app
npm test            # unit + integration (the core in plain Node, driven by the real CLI), then the mod's tests (claude plugin test)
npm run typecheck
npm run e2e         # launches Electron via Playwright, checks behavior, writes screenshots to test/screenshots/
npm run demo -- <session-id>   # open a glass seeded with demo content
node scripts/readme-media.mjs  # regenerate the README screenshots and GIF (docs/media/; needs ffmpeg)
```

`CLAUDE.md` is the working guide for Claude (and people) changing this code: the rules of the road
and the gotchas. `test/fixtures/mod-events.ndjson` is a real session recorded through the mod;
trust it over docs. To inspect a real glass, `CLAUDE_GLASS_DEBUG_PORT=9333 claude-glass open`
exposes it over the Chrome DevTools Protocol. To try the mod from a checkout,
`claude --plugin-dir ~/claude-glass`; `claude plugin validate .` checks it.

```
src/core/       server, reducer, events, layout, config, guide, custom apps (pure Node)
src/apps/       built-in apps: <type>/index.ts (core) + view.tsx + view.css + guide.md
src/sdk/        the app SDK (bridge between a view frame and the glass)
src/main/       Electron main: window, protocols, permissions, browser streams, fetched pages
src/renderer/   the shell: desktops, windows, launcher, docks, settings
src/cli/        the claude-glass CLI
hooks/          the glass mod (glass-mod.ts) that feeds the glass from inside Claude Code
skills/, scripts/, bin/   the rest of the Claude Code plugin
```

## Known limits

- macOS only for now.
- Needs Claude Code mods (2.1.287+); without them the glass opens but doesn't fill itself.
- Primarily one-way: you can arrange and read, but nothing you do in the glass reaches Claude yet.

## License

MIT. Use it however you like.
