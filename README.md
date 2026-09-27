# Claude Glass

Claude's monitor. Claude Glass is a desktop window bound to one Claude Code session that works
like a screen share from Claude to you. As Claude works, the window fills itself: the
conversation, every tool call it runs, diffs of every file it edits, its plans, and the images it
looks at. When Claude wants to *show* you something, like a chart, a mockup, a comparison or a
write-up, it puts it on the glass with one command.

It's built for working with Claude like a coworker, especially by voice, when you can't easily see
what Claude sees. It is deliberately one-way: Claude shows, you watch.

*Why "Claude Glass"?* A [Claude glass](https://en.wikipedia.org/wiki/Claude_glass) was an
18th-century tinted mirror that painters and travelers used to look at a scene through glass,
named after the painter Claude Lorrain. This one lets you look at Claude's work the same way.

![Seeded glass](docs/screenshot.png)

## How it works

- **One window per session.** Every Claude Code session can have its own glass (a separate
  Electron process). Close it and it's fully off; hooks do nothing, and nothing is recorded.
  Reopen it later and its history comes back.
- **Automatic apps.** Hooks feed the Conversation (streamed live), Terminal (every tool call,
  filterable), Changes (diffs you can flip through revision by revision), Plan (plan files and
  plan mode) and Images (images Claude reads). None of this costs Claude any tokens.
- **Deliberate apps.** Claude can open Markdown viewers, image viewers, diff viewers, and
  freeform HTML canvases (sandboxed) through the `claude-glass` CLI.
- **Auto-tiling desktops.** Windows form one ordered list. New windows open in the first slot of
  the first desktop and push the rest along; overflow spills onto the next desktop. Each desktop
  has a layout (full, side by side, one big + two small, three columns, grid). Drag a title bar
  to reorder; hold it at the screen edge to move to the next desktop. Claude never changes which
  desktop you're looking at.

## Install

Requirements: macOS, Node 20+, `jq` and `nc` (both ship with macOS).

```sh
git clone <this repo> ~/claude-glass
cd ~/claude-glass
npm install
npm run build
```

Then load it as a Claude Code plugin. To try it without installing:

```sh
claude --plugin-dir ~/claude-glass
```

To install it permanently, add the folder through a local marketplace (`/plugin` in Claude Code).

## Use

Inside a Claude session, ask Claude to "open the glass", or run `/claude-glass:glass`. From
a shell:

```sh
claude-glass open            # opens the glass for $CLAUDE_CODE_SESSION_ID
claude-glass view            # what's on screen
claude-glass show plan.md    # markdown / image / html by extension
claude-glass close
claude-glass status          # all glass windows, open or closed
```

Full command reference: `claude-glass help` (or see PLAN.md §4.6).

To open a glass automatically for every session, set `autoStart` in Settings (the gear in the
dock) or in `~/.claude/claude-glass/config.json`:

```json
{ "autoStart": true, "background": "aurora", "defaultLayout": "grid", "windowOpacity": 0.78 }
```

`background` is a preset (`aurora`, `dune`, `tide`, `graphite`) or an absolute image path.

`scope` picks what a glass belongs to. `session` (default) gives each Claude session its own
glass; after `/clear` you start fresh, and `claude --resume` picks the old glass back up.
`folder` gives each project folder one glass that every session in it feeds, so `/clear`,
restarts and resumes all continue in the same window. A folder glass's id is
`sha256(project dir)[:12]`, the same id Voice Multiplexer uses for the folder.

## Using the glass

- **Desktops**: windows tile into desktops; ⌘←/⌘→, a horizontal swipe, or scrolling outside
  windows moves between them. Drag a title bar to reorder; drag to a side edge and hold to move a
  window to the next desktop.
- **Edge sidebars (pin)**: while dragging a window (or its dock icon), drop it on the pin target in
  the middle of an edge, or hold ⌘ for full-edge strips, to pin it to that sidebar. Hover the edge
  to slide a sidebar out; its round handle keeps it open (the layout makes room), and its inner edge
  drags to resize. Useful for things you interact with, like a voice app.
- **Nested view** (Settings): one screen, newest window big, older ones spiral smaller; scroll or
  ⌘↑/⌘↓ to walk back.
- **History mode** (Settings, per session): every edit, plan, image, search and page opens its own
  window, newest first, so the glass reads as a timeline.
- **Browser**: Claude's web searches and fetched pages show up live (with back/forward, history,
  and passages Claude highlights); a Playwright/Chrome DevTools browser can stream in too.
- **Dock**: click to open/show; drag icons to reorder windows or onto an edge to pin them.
- **Settings**: every app can be turned off; custom apps show what they're allowed to use.

Claude can see all of this with `claude-glass view`, and change display settings when you ask
(`claude-glass settings`).

## Custom apps

Every window is an app, and anyone can write one: drop a folder into
`~/.claude/claude-glass/apps/` (or run `claude-glass apps new <name>`) and restart the glass.
Apps can fill themselves from Claude Code hooks, take commands from Claude, and ship their own
instructions for Claude. The built-in apps use the same format; `claude-glass apps copy <type>`
copies one so you can change it. See [docs/apps.md](docs/apps.md).

## Files

```
~/.claude/claude-glass/config.json                 global settings
~/.claude/claude-glass/apps/<type>/                custom apps
~/.claude/claude-glass/sessions/<id>/state.json    a glass's saved state
~/.claude/claude-glass/sessions/<id>/glass.log    Electron log
/tmp/claude-glass-<uid>/<id>.sock                  live glass socket
/tmp/claude-glass-<uid>/<session>.sock             folder scope: symlink to the folder glass's socket
```

## Develop

See `CLAUDE.md` for the working guide and `PLAN.md` for the design record and status.

```sh
npm test          # unit + integration (core runs in plain Node)
npm run e2e       # Electron + Playwright screenshots → test/screenshots/
npm run demo      # open a glass with demo content
```

## Known limits

- macOS only for now.
- `/clear` starts a new Claude session ID, so the old glass stops receiving updates. Open a
  new glass for the new session.
- One-way: you can arrange windows, but you can't send anything back to Claude from the glass yet.
