---
name: canvas
description: Open or use Claude Canvas, a window that acts as your monitor/screen share for the user. Use when the user asks to open/start/close the canvas, or when a canvas is open and showing something visually (plan, diagram, chart, mockup, comparison, screenshot) would help them.
---

# Claude Canvas

Claude Canvas is a desktop window bound to this Claude Code session. It shows the user what
you are doing: conversation, every tool call (terminal), diffs of your edits ("changes"), plan
files ("plan"), images you read ("images"). Those fill in automatically from hooks.

The `claude-canvas` command is on your PATH (from this plugin's `bin/`). It knows your session
from `CLAUDE_CODE_SESSION_ID`.

- Open: `claude-canvas open`. It prints the full usage guide; read it.
- Close: `claude-canvas close`
- Check what's on screen: `claude-canvas view`

If `claude-canvas` reports "canvas is not open", the user has it turned off. Don't open it
unless they ask.

If the command is missing, the plugin isn't built. Tell the user to run
`npm install && npm run build` in `${CLAUDE_PLUGIN_ROOT}`.
