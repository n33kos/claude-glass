// Printed by `claude-glass open` and injected by SessionStart when the glass is live.
// It lands in Claude's context: keep it tight. The user wants the glass used heavily (show,
// then direct attention). North star: window order = a ranking of the user's attention (primary,
// secondary, tertiary); re-rank when that changes, not per tool call.
import { APPS } from '../apps/registry';
import { settingValues, type AppDef } from '../apps/types';
import type { GlobalConfig } from './types';

export const GUIDE = `# Claude Glass is open for this session

The user is watching a window: your monitor, a live visual layer over everything you do. Hooks
fill in the basics on their own (conversation, terminal, "changes" diffs, "plan", "images",
tasks, agents, tests, files), but that's only the floor. The user wants you to use the glass
heavily and take the extra effort to make it a beautiful, current picture of the work. While it's
open, showing is part of every answer, not an extra.

Show, don't only tell:
- Whenever a picture carries an idea faster than prose, put one up: a diagram of the code path you
  just traced, the flow of a fix, options side by side, a chart of numbers, a mockup, a screenshot,
  a short card of findings. Reach for the diagram app's templates first; use an html canvas for
  anything custom (charts, mockups), and make it polished.
- Before multi-step work, put the plan up and keep it current as steps land.
- One window per topic: reuse ids (\`--id\`) and update it as understanding grows, instead of
  piling up near-duplicates.

Direct attention, continuously. Hooks and \`app\` commands never move windows; that's your job.
The window order is a ranking of the user's attention: keep it matching what deserves their focus
right now.
- Primary focus at index 0: what you're about to talk about, the diff you just made, the failing
  test, the page you relied on (\`show <file> --id <id>\` updates and moves it there; after an
  \`app\` command, \`window move <id> 0\`).
- Secondary and tertiary next (index 1, 2...): what the primary needs beside it, like the plan
  behind a diff, the numbers behind a chart. Pick a layout that gives each its due. Send stale
  windows back or close them.
- Re-rank whenever that ranking changes: a new primary, or context that stops or starts mattering.
  That can happen within one topic, and a new topic can keep the same ranking. Don't reshuffle on
  every tool call; each move should read as a presenter shifting the user's attention on purpose.
- Run \`claude-glass view\` before re-ranking (the user may have moved things), and leave windows
  the user docked at an edge or corner alone.

Work visibly: hooks only see your dedicated tools. Change files with Edit/Write (never sed, python,
or heredocs through Bash; those edits never reach "changes"), write plans to plan files, and Read
images you want to discuss.

  claude-glass view                         layout: display modes, desktops, each window's slot + position,
                                             docked windows (edges and corners), closed apps
  claude-glass show <file> [--id ID] [--title T]   .md → markdown, image → image, .html → html. Opens at 0
  claude-glass new <type> [--id ID] [--title T]    types: markdown, html, image, diff, browser, diagram
  claude-glass app <id> <command> [--text T | --file F] [--key value]
      markdown: set|append   html: render   image: add --file F [--caption C]
      diff: add --path P --before-file A --after-file B     terminal: log --text T
  claude-glass window open|close <id>        open = bring back at index 0
  claude-glass window move <id> <index>      move to 0 to bring something to the user's attention
  claude-glass layout <desktop#> full|split|main-left|main-left-nest|columns|grid
  claude-glass catalog                       all apps and commands
  claude-glass background --colors "#hex,…" | reset   optional: tint this glass's light yourself
  claude-glass preset list | apply <name>    the user's saved frames (docks, layouts, settings), each
                                             with a description; apply one when the user asks, or pick
                                             the one whose description fits when they ask you to set up

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

/**
 * An app guide for the current settings: `<!-- when key=value -->` starts a block kept only when
 * the setting matches; the next `when` or `<!-- end -->` closes it. Text outside blocks always stays.
 */
export function guideForSettings(text: string, settings: Record<string, string>): string {
  let keep = true;
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const when = line.match(/^\s*<!--\s*when\s+([A-Za-z0-9.]+)\s*=\s*([^\s>]+)\s*-->\s*$/);
    if (when) { keep = settings[when[1]] === when[2]; continue; }
    if (/^\s*<!--\s*end\s*-->\s*$/.test(line)) { keep = true; continue; }
    if (keep) out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function guideFor(config: Pick<GlobalConfig, 'defaultLayout'> & Partial<Pick<GlobalConfig, 'disabledApps' | 'nestedView' | 'appSettings'>> & { windowMode?: 'live' | 'history' }): string {
  const settings = { windowMode: config.windowMode ?? 'live', nestedView: String(!!config.nestedView) };
  // Each app's guide also sees its own settings by key (`<!-- when grid=true -->`).
  const own = (a: AppDef) => Object.fromEntries(Object.entries(settingValues(a, config.appSettings?.[a.type])).map(([k, v]) => [k, String(v)]));
  const apps = Object.values(APPS)
    .filter((a) => a.guide && !config.disabledApps?.includes(a.type))
    .map((a) => ({ a, text: guideForSettings(a.guide!, { ...own(a), ...settings }) }))
    .filter((g) => g.text);
  const appGuides = apps.length
    ? '\n\n# Installed apps\n' + apps.map(({ a, text }) => `\n## ${a.title} (\`${a.type}\`)\n${text}`).join('\n')
    : '';
  const layout = config.nestedView ? NESTED_VIEW : config.defaultLayout === 'claude' ? CLAUDE_LAYOUT : '';
  const history = config.windowMode === 'history' ? HISTORY_MODE : '';
  return GUIDE + layout + history + appGuides;
}
