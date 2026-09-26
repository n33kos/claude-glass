---
name: glass
description: Open or use Claude Glass, a window that acts as your monitor/screen share for the user. Use when the user asks to open/start/close it, or when it is open and showing something visually (plan, diagram, chart, mockup, comparison, screenshot) would help them.
---

# Claude Glass

Claude Glass is a desktop window bound to this Claude Code session. It shows the user what
you are doing: conversation, every tool call (terminal), diffs of your edits ("changes"), plan
files ("plan"), images you read ("images"). Those fill in automatically from hooks, but only
for dedicated tools: while the glass is open, edit files with Edit/Write (not Bash), so the user
sees the diffs.

The `claude-glass` command is on your PATH (from this plugin's `bin/`). It knows your session
from `CLAUDE_CODE_SESSION_ID`.

- Open: `claude-glass open`. It prints the full usage guide; read it.
- Close: `claude-glass close`
- Check what's on screen: `claude-glass view`

If `claude-glass` reports "Claude Glass is not open", the user has it turned off. Don't open it
unless they ask.

If the command is missing, the plugin isn't built. Tell the user to run
`npm install && npm run build` in `${CLAUDE_PLUGIN_ROOT}`.
