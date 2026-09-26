# Claude Canvas

Claude's monitor. Claude Canvas is a desktop window bound to one Claude Code session that works
like a screen share from Claude to you. As Claude works, the window fills itself: the
conversation, every tool call it runs, diffs of every file it edits, its plans, and the images it
looks at. When Claude wants to *show* you something, like a chart, a mockup, a comparison or a
write-up, it puts it on the canvas with one command.

It's built for working with Claude like a coworker, especially by voice, when you can't easily see
what Claude sees.

![Seeded canvas](docs/screenshot.png)

## How it works

- **One window per session.** Every Claude Code session can have its own canvas (a separate
  Electron process). Close it and it's fully off; hooks do nothing, and nothing is recorded.
  Reopen it later and its history comes back.
- **Automatic apps.** Hooks feed the Conversation (streamed live), Terminal (every tool call,
  filterable), Changes (diffs you can flip through revision by revision), Plan (plan files and
  plan mode) and Images (images Claude reads). None of this costs Claude any tokens.
- **Deliberate apps.** Claude can open Markdown viewers, image viewers, diff viewers, and
  freeform HTML canvases (sandboxed) through the `claude-canvas` CLI.
- **Auto-tiling desktops.** Windows form one ordered list. New windows open in the first slot of
  the first desktop and push the rest along; overflow spills onto the next desktop. Each desktop
  has a layout (full, side by side, one big + two small, three columns, grid). Drag a title bar
  to reorder; hold it at the screen edge to move to the next desktop. Claude never changes which
  desktop you're looking at.

## Install

Requirements: macOS, Node 20+, `jq` and `nc` (both ship with macOS).

```sh
git clone <this repo> ~/claude-canvas
cd ~/claude-canvas
npm install
npm run build
```

Then load it as a Claude Code plugin. To try it without installing:

```sh
claude --plugin-dir ~/claude-canvas
```

To install it permanently, add the folder through a local marketplace (`/plugin` in Claude Code).

## Use

Inside a Claude session, ask Claude to "open the canvas", or run `/claude-canvas:canvas`. From
a shell:

```sh
claude-canvas open            # opens the canvas for $CLAUDE_CODE_SESSION_ID
claude-canvas view            # what's on screen
claude-canvas show plan.md    # markdown / image / html by extension
claude-canvas close
claude-canvas status          # all canvases, open or closed
```

Full command reference: `claude-canvas help` (or see PLAN.md §4.6).

To open a canvas automatically for every session, set `autoStart` in Settings (the gear in the
dock) or in `~/.claude/claude-canvas/config.json`:

```json
{ "autoStart": true, "background": "aurora", "defaultLayout": "grid", "windowOpacity": 0.78 }
```

`background` is a preset (`aurora`, `dune`, `tide`, `graphite`) or an absolute image path.

## Files

```
~/.claude/claude-canvas/config.json                 global settings
~/.claude/claude-canvas/sessions/<id>/state.json    a canvas's saved state
~/.claude/claude-canvas/sessions/<id>/canvas.log    Electron log
/tmp/claude-canvas-<uid>/<id>.sock                  live canvas socket
```

## Develop

See `CLAUDE.md` for the working guide and `PLAN.md` for the design record and status.

```sh
npm test          # unit + integration (core runs in plain Node)
npm run e2e       # Electron + Playwright screenshots → test/screenshots/
npm run demo      # open a canvas with demo content
```

## Known limits

- macOS only for now.
- `/clear` starts a new Claude session ID, so the old canvas stops receiving updates. Open a
  new canvas for the new session.
- One-way: you can arrange windows, but you can't send anything back to Claude from the canvas yet.
