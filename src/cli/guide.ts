// Printed by `claude-canvas open` and injected by SessionStart when the canvas is live.
// Keep it short: it lands in Claude's context.
export const GUIDE = `# Claude Canvas is open for this session

The user can see a canvas window: Claude's monitor/screen share. It fills itself from hooks:
conversation, terminal (every tool call), "changes" (diffs of your edits), "plan" (plan files),
"images" (images you Read). Use the \`claude-canvas\` CLI to deliberately SHOW the user things
visually when that would help: plans, diagrams, comparisons, mockups, screenshots, summaries.
Don't overdo it; one well-chosen visual beats many.

Work visibly while the canvas is open. Hooks only see your dedicated tools, so prefer the ones
that feed the canvas: change files with Edit/Write (never sed, python, or heredocs through Bash;
those edits never reach "changes"), write plans to plan files, and Read images you want to discuss.

  claude-canvas view                          layout: desktops, windows (index 0 = first slot), closed apps
  claude-canvas show <file> [--id ID] [--title T]   .md → markdown, image → image, .html → html. Opens at 0
  claude-canvas new <type> [--id ID] [--title T]    types: markdown, html, image, diff
  claude-canvas app <id> <command> [--text T | --file F] [--key value]
      markdown: set|append   html: render   image: add --file F [--caption C]
      diff: add --path P --before-file A --after-file B     terminal: log --text T
  claude-canvas window open|close <id>        open = bring back at index 0
  claude-canvas window move <id> <index>      move to 0 to bring something to the user's attention
  claude-canvas window pin <id> [index]       keep a window at a slot; others flow around it. unpin <id>
  claude-canvas layout <desktop#> full|split|main-left|columns|grid
  claude-canvas catalog                       all apps and commands

Treat the canvas as a live feed of your focus. Hook updates (and \`app\` commands) never move
windows, so directing attention is your job:
- When you show or update something the user should look at now, bring it to index 0. Reuse a
  window with \`show <file> --id <id>\`, which updates it and moves it to 0, or run
  \`window move <id> 0\` after an \`app\` command. Don't pile up near-duplicate windows.
- As the work shifts, reorder to match: what you're discussing or changing goes first, and
  supporting context goes next to it (the plan beside the diff it drives, the chart beside its
  numbers). Move stale windows back or close them.
- Before rearranging, run \`claude-canvas view\` (the user may have moved things). Never move or
  unpin windows the user pinned; the rest flow around them. Don't reshuffle on every tool call;
  move windows when the topic changes.
HTML canvases are sandboxed iframes: inline your CSS/JS; scripts may also load from cdn.jsdelivr.net,
cdnjs.cloudflare.com or unpkg.com (e.g. Chart.js, Mermaid). fetch/XHR are blocked.`;
