// Printed by `claude-glass open` and injected by SessionStart when the glass is live.
// Keep it short: it lands in Claude's context.
import { APPS } from '../apps/registry';
import type { GlobalConfig } from './types';

export const GUIDE = `# Claude Glass is open for this session

The user can see a window: Claude's monitor/screen share. It fills itself from hooks:
conversation, terminal (every tool call), "changes" (diffs of your edits), "plan" (plan files),
"images" (images you Read). Use the \`claude-glass\` CLI to deliberately SHOW the user things
visually when that would help: plans, diagrams, comparisons, mockups, screenshots, summaries.
Don't overdo it; one well-chosen visual beats many.

Work visibly while the glass is open. Hooks only see your dedicated tools, so prefer the ones
that feed the glass: change files with Edit/Write (never sed, python, or heredocs through Bash;
those edits never reach "changes"), write plans to plan files, and Read images you want to discuss.

  claude-glass view                          layout: display modes, desktops, each window's slot + position,
                                             pinned edge sidebars, closed apps
  claude-glass show <file> [--id ID] [--title T]   .md → markdown, image → image, .html → html. Opens at 0
  claude-glass new <type> [--id ID] [--title T]    types: markdown, html, image, diff, browser
  claude-glass app <id> <command> [--text T | --file F] [--key value]
      markdown: set|append   html: render   image: add --file F [--caption C]
      diff: add --path P --before-file A --after-file B     terminal: log --text T
  claude-glass window open|close <id>        open = bring back at index 0
  claude-glass window move <id> <index>      move to 0 to bring something to the user's attention
  claude-glass layout <desktop#> full|split|main-left|columns|grid
  claude-glass catalog                       all apps and commands

Treat the glass as a live feed of your focus. Hook updates (and \`app\` commands) never move
windows, so directing attention is your job:
- When you show or update something the user should look at now, bring it to index 0. Reuse a
  window with \`show <file> --id <id>\`, which updates it and moves it to 0, or run
  \`window move <id> 0\` after an \`app\` command. Don't pile up near-duplicate windows.
- As the work shifts, reorder to match: what you're discussing or changing goes first, and
  supporting context goes next to it (the plan beside the diff it drives, the chart beside its
  numbers). Move stale windows back or close them.
- Before rearranging, run \`claude-glass view\` (the user may have moved things). Leave windows the
  user pinned to an edge sidebar alone. Don't reshuffle on every tool call; move windows when the topic
  changes.
HTML canvases are sandboxed iframes: inline your CSS/JS; scripts may also load from cdn.jsdelivr.net,
cdnjs.cloudflare.com or unpkg.com (e.g. Chart.js, Mermaid). fetch/XHR are blocked.

If the user asks to change how the glass presents things (nested view, history mode, layouts,
opacity, background...), \`claude-glass settings\` lists every setting and its values;
\`claude-glass settings set <key> <value>\` changes one (e.g. \`settings set nestedView true\`).
Only change settings when the user asks.

Browser: when you drive a browser, stream it here instead of opening a window. ALWAYS run it
headless (the glass is the user's view of it; a second visible browser is just noise) with a
DevTools port, then attach and bring it forward:
  Playwright: chromium.launch({ headless: true, args: ['--remote-debugging-port=9222'] })
  Chrome/Chromium: --headless=new --remote-debugging-port=9222
  claude-glass app browser attach [--cdp 9222] && claude-glass window move browser 0
Web searches and pages you fetch show up there on their own. After reading a page, point the
user at the passage you relied on: \`claude-glass app browser highlight --text "<a few exact words
from the page>"\` (ask WebFetch to quote verbatim so the words match).
The CDP view follows the most recently active tab. Browsers without CDP (Firefox, WebKit): save a
screenshot after each step and run \`claude-glass app browser frame --file shot.png [--url U]\`.`;


const CLAUDE_LAYOUT = `

Layouts are yours to pick (the user chose "Claude decides"). New desktops start with a layout
that fits their window count; when you put things on screen, set the desktop's layout for what it
shows: one thing to read closely → full; two to compare → split; a focus plus context →
main-left; three peers → columns; four at a glance → grid. Change it when the work changes, not
on every update.`;

/** The guide for this user's settings plus the instructions each installed app ships. */
const NESTED_VIEW = `

The user has the nested view on: one screen, index 0 is the big pane and each later window gets
half of the space left. There are no desktops or layouts (\`layout\` is refused). Put what you're
talking about at index 0; older things naturally recede.`;

const HISTORY_MODE = `

The user has history mode on: every edit, plan, image, search and page opens in its own new window,
newest first, so the glass reads as a timeline. Windows stay in time order; \`window move\` is refused.`;

export function guideFor(config: Pick<GlobalConfig, 'defaultLayout'> & Partial<Pick<GlobalConfig, 'disabledApps' | 'nestedView'>> & { windowMode?: 'live' | 'history' }): string {
  const apps = Object.values(APPS).filter((a) => a.guide && !config.disabledApps?.includes(a.type));
  const appGuides = apps.length
    ? '\n\n# Installed apps\n' + apps.map((a) => `\n## ${a.title} (\`${a.type}\`)\n${a.guide}`).join('\n')
    : '';
  const layout = config.nestedView ? NESTED_VIEW : config.defaultLayout === 'claude' ? CLAUDE_LAYOUT : '';
  const history = config.windowMode === 'history' ? HISTORY_MODE : '';
  return GUIDE + layout + history + appGuides;
}
