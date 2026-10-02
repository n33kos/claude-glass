# Writing Claude Glass apps

Every window in Claude Glass is an app, and every app, built-in or yours, uses the same format.
Drop a folder into `~/.claude/claude-glass/apps/`, restart the glass, and it's there.

```
claude-glass apps new my-app      # starter app in ~/.claude/claude-glass/apps/my-app
claude-glass apps copy diff       # copy a built-in to modify it (yours overrides it)
claude-glass apps                 # what's installed, and why a broken app didn't load
claude-glass close && claude-glass open   # restart the glass to pick up changes
```

The glass is primarily one-way: Claude shows, the user watches. An app displays things; its view can
change how things are viewed (select, page, filter) but has no way to send anything to Claude.

## The folder

```
my-app/
  glass-app.json   manifest
  core.js          state logic (CommonJS)
  view.html        what the window shows (optional; runs in a sandboxed frame)
  guide.md         instructions for Claude (optional)
  icon.svg         the app's icon (optional; or icon.png, or name a file in "icon")
```

### `glass-app.json`

```json
{
  "apiVersion": 1,
  "type": "my-app",
  "title": "My App",
  "icon": "✦",
  "singleton": true,
  "description": "What it shows. Claude sees this in `claude-glass catalog`.",
  "autoOpen": false,
  "commands": {
    "set":    { "usage": "set --text <text>", "help": "Show some text" },
    "select": { "usage": "select --index <n>", "help": "Show item n", "view": true }
  },
  "viewCommands": [],
  "internal": []
}
```

| Field | Meaning |
|---|---|
| `type` | id: lowercase letters, digits, dashes. Same as a built-in's → replaces it |
| `icon` | a glyph (`"✦"`) or an image file in the folder (`"icon.svg"`); an `icon.svg`/`icon.png` in the folder is used automatically. Images fill the dock tile, so give them their own background. |
| `singleton` | one window, whose id is `type`. Otherwise `claude-glass new my-app` makes more |
| `commands` | what Claude can run: `claude-glass app <id> <command> --key value`. Flags arrive as `args` |
| `view: true` / `viewCommands` | commands the view may run too (view-only changes) |
| `internal` | commands hidden from Claude's catalog (used by your view or `onEvent` only) |
| `autoOpen` | open the window the first time `onEvent` creates it |

### `core.js`

Pure functions over your app's own state. They run in the glass's main process (plain Node).
State is saved with the session and restored when the glass reopens.

```js
exports.init = () => ({ items: [] });

exports.command = (state, command, args) => {
  if (command === 'set') return { ...state, text: String(args.text ?? '') };
  throw new Error(`my-app: unknown command "${command}"`); // shown to Claude
};

// Optional: every session event (below). Return the same object when nothing changes. A
// singleton is created the first time this returns something new.
exports.onEvent = (state, event) => {
  if (event.e === 'tool.end' && event.tool === 'Bash') return { ...state, runs: (state.runs ?? 0) + 1 };
  return state;
};
```

Keep it pure: no I/O, no timers, no globals. Return new objects instead of mutating. Keep
state small (it's saved as JSON); cap lists.

### Session events

The glass mod watches the Claude Code session and sends the glass these events (`event.e` names
each one; the types are `GlassEvent` in `src/core/events.ts`). A tool's `input` is its arguments
and `result` its own record, as Claude Code keeps it (Edit's `structuredPatch`, Bash's `stdout`).

| `e` | Fields | When |
|---|---|---|
| `session.start` | `source` (`startup`, `clear`, `resume`, `compact`), `sessionId`, `cwd` | a conversation starts |
| `turn.start` | `turnId`, `text` (the prompt; empty for a continuation) | a turn begins |
| `text` | `id`, `turnId`, `text` (the block's text so far), `final` | the reply streams |
| `tool.start` | `id`, `tool`, `input`, `agentId` (a subagent's call), `cwd` | a tool is about to run |
| `tool.end` | the same, plus `result` or `error`, `durationMs` | it finished (or failed, or was refused) |
| `permission` | `tool`, `input` | Claude Code is asking the user's permission |
| `turn.complete` | `turnId`, `durationMs`, `reason`, `aborted` | the turn ended |
| `agent.end` | `agentId`, `answer`, `aborted` | a subagent's run ended |
| `session.end` | `reason` | the session ended (or `/clear`) |

An app that exports the old `onHook` doesn't load: it was replaced by `onEvent`.

### `view.html`

A normal web page, loaded in a sandboxed frame inside the window (scripts and forms allowed). Use any framework or none.
It can load its own files (relative paths) and scripts from cdn.jsdelivr.net,
cdnjs.cloudflare.com or unpkg.com. It has no network access, no storage, and no access to
the shell.

```html
<link rel="stylesheet" href="glass-app://sdk/glass-app.css">   <!-- the glass's look -->
<script src="glass-app://sdk/glass-app.js"></script>
<script>
  glass.onState(({ state, meta, size, session }) => { /* render */ });
  glass.run('select', { index: 2 });          // a view command
  glass.host('lightbox', { src, alt });        // full-window image viewer
</script>
```

Props: `state` (your app's state), `meta` (`id`, `type`, `title`), `size` (`width`, `height`),
`session` (`cwd`, `activity: 'idle' | 'working'`, `ended`, `waiting`).

The stylesheet gives you the glass's design tokens and bundled fonts (Graphite Mono, in
[design.md](design.md)): roles like `--text-1/2/3`, `--surface-*`, `--border`, `--accent`,
`--ok/--warn/--bad` and scales for type, space, radius and motion. Use roles, not raw colors, and
your app follows the glass's theme (dark or light) for free. The page background is transparent so
the window's glass shows through. Your content and icon can be any color.

Images the glass stored (e.g. from `claude-glass show`) are at `glass-file://f<absolute path>`.

`glass.ask(service, args)` is a host service that answers (a Promise). Today: `read-doc`
`{ path }` → `{ path, text }`, for the markdown viewer following links (local markdown and text
files only). `glass.host('open-link', { url })` opens an http(s) or
mailto link in the user's browser; a frame can't navigate itself.

The built-in apps are written in React with `src/sdk/react.tsx` (`mount(View)`), which wraps
the same bridge. Their sources come along when you copy one (`src/`).

### `guide.md`

Appended to the instructions Claude gets when the glass opens (up to 1,500 characters). Say
when to use your app and which commands to run. This is how you shape Claude's behavior with
your app.

Parts that only apply in one mode go in a block; the rest is always included:

    <!-- when windowMode=live -->
    Reuse one window: `claude-glass show pic.png --id images`.
    <!-- when windowMode=history -->
    Each image opens its own window; that's expected.
    <!-- end -->

Keys: `windowMode` (`live` | `history`), `nestedView` (`true` | `false`), and your app's own
settings by key (below).

### Settings

An app can declare its own settings in the manifest. They show under the app in Settings → Apps,
Claude can list and set them (`claude-glass settings`, `claude-glass settings set
app.<type>.<key> <value>`), your view gets the values (defaults filled in) as `settings` in its
props, and `guide.md` blocks can depend on them.

    "settings": {
      "gridSize": { "type": "number", "label": "Images in the grid", "default": 12, "min": 2, "max": 40 },
      "compact":  { "type": "bool", "label": "Compact rows", "default": false },
      "theme":    { "type": "enum", "label": "Theme", "default": "dark", "options": ["dark", "light"] },
      "accent":   { "type": "color", "label": "Accent", "default": "#6c5ce7" },
      "greeting": { "type": "text", "label": "Greeting", "default": "Hi" }
    }

Keys are letters and digits. Values are validated against the type (and `min`/`max`/`options`);
they're global (every glass), stored in the glass config under `appSettings.<type>`.

### Stored values

Settings are the user's choices. What your app itself needs to remember (pinned items, a
favorite view, a running total) goes in **stored values**: declare each key with a scope and a
default, and the glass keeps them, saves them and hands them back. Your code never does I/O.

    "stored": {
      "pinned":   { "scope": "project", "default": [] },
      "total":    { "scope": "global",  "default": 0 },
      "lastNote": { "scope": "session", "default": "" }
    }

| Scope | Shared by | Saved in |
|---|---|---|
| `session` | this glass | the glass's `state.json`, with the rest of its state |
| `project` | every glass in the project folder: survives `/clear`, restarts, resumes | `~/.claude/claude-glass/projects/<folder id>/stored/<type>.json` |
| `global` | every glass | `~/.claude/claude-glass/stored/<type>.json` |

In `core.js`, `command` and `onEvent` get a third argument, `ctx`: `ctx.stored` holds the values
(defaults filled in), and returning `ctx.store(nextState, { key: value })` changes your state and
writes those values (undefined resets one to its default):

```js
exports.command = (state, command, args, ctx) => {
  if (command === 'pin') return ctx.store(state, { pinned: [...ctx.stored.pinned, String(args.item)] });
  ...
};
```

Your view gets them as `stored` in its props and writes with `glass.store({ key: value })`
(React: the `store` prop). A change in one glass reaches every other glass that shares the scope
within a couple of seconds; the last write wins. Values are JSON, at most 256 KB per app per
scope, and only declared keys are accepted. Anything you don't need to keep belongs in your app's
own state or in plain variables.

The user (or Claude) can look at and change them with `claude-glass stored <type>`,
`claude-glass stored <type> set <key> <json>` and `claude-glass stored <type> reset [key]`;
Settings → Apps shows how many values an app keeps, with a Reset link.

### Public state

Apps can read each other, safely: both sides opt in. An app that has something to offer exports
`share(state)` from `core.js`, a pure function that picks what other apps may see (JSON, up to
64 KB per window; leave out anything private, return `undefined` to share nothing):

```js
exports.share = (state) => ({ counts: state.counts }); // not state.note
```

An app that wants to read it lists the type in its manifest, and Settings shows the user which
apps read which:

```json
"permissions": { "reads": ["tool-count"] }
```

The reader gets every open window of those types as `[{ id, type, title, data }]`: its view as
the `shared` prop, its core as `ctx.shared` in `command` and `onEvent`. Reading is all it gets:
it can't change another app's state or run its commands. Without `reads`, nothing is visible.

## Two-way apps

The glass is one-way unless an app says otherwise: with `"permissions": { "twoWay": true }` in
its manifest (Settings shows it as "answering Claude"), an app may hook the Claude session, like a
[Claude Code mod](https://code.claude.com/docs/en/plugins/mods/overview)'s `register(on)`.
The glass mod forwards the events your app hooks, before Claude Code acts on them:

```js
exports.register = (on) => {
  // Refuse something, or ask the user in the glass first.
  on('tool.call', { tool: 'Bash' }, async (glass, e, next) => {
    if (/\bdeploy\b/.test(e.input.command)) {
      const answer = await glass.ask(`Run "${e.input.command}"?`, ['Yes, deploy', 'No']);
      if (answer !== 'Yes, deploy') return { deny: `The user said "${answer}".` };
    }
    return next(e);
  });
  // Add something Claude reads with every prompt.
  on('prompt.submit', async (glass, e, next) => next({ ...e, context: [...e.context, 'Deploys need an OK.'] }));
};
```

| Event | `e` | A handler returns |
|---|---|---|
| `prompt.submit` | `{ text, context }` | `next({ ...e, text })`, `next({ ...e, context })`, or `{ drop: reason }` |
| `tool.call` | `{ tool, input, agentId? }` | `next(e)`, `{ deny: reason }` (Claude reads it), or `{ result }` (in place of running the tool) |

A matcher (the second argument) filters on the event's fields: a value, a list, or a pattern.
Handlers run in app order, before Claude Code acts (there's no "after"); one that throws or takes
over 10 seconds of its own time is skipped. `glass` is your app's handle: `glass.stored` and
`glass.store(patch)` (its stored values), and `glass.ask(question, options)`, which puts the
question on an Action card and waits for the user (that wait doesn't count toward the 10 seconds;
it gives up after nine and a half minutes).

A two-way app's view commands run only from the glass's own window, never from the CLI or the
socket, so only the user's clicks can answer anything. A two-way view (and a built-in one) can
also offer **point and ask**: `glass.host('attach', { label, text })` puts `text` on the user's
next prompt as context Claude reads, shown as a chip in the top bar until then.

## Permissions

By default a view has no network, no microphone and no storage. An app that needs them says so
in its manifest; the user sees what each app can use in Settings (and in `claude-glass apps`).

```json
"permissions": {
  "network": ["http://127.0.0.1:3100", "ws://127.0.0.1:3100"],
  "microphone": true,
  "storage": true,
  "sharedSignIn": true
}
```

| Permission | What the view gets |
|---|---|
| `network` | fetch/WebSocket/scripts/images/frames to exactly these origins (http(s)/ws(s), no wildcards). Servers still apply their own CORS. |
| `microphone` | `getUserMedia({ audio: true })` (never the camera), for the view and for pages it embeds from its `network` origins (give the inner iframe `allow="microphone"`). macOS will also ask the user once. |
| `storage` | its own persistent `localStorage`/IndexedDB, at origin `glass-app://<type>` |
| `twoWay` | hooks on the Claude session (`register(on)`, above), and point and ask from its view |
| `reads` | other apps' public state, for the types listed (see Public state) |
| `sharedSignIn` | the sign-in of pages it embeds from its `network` origins follows the user to every glass: their `localStorage` and cookies, saved together in `~/.claude/claude-glass/app-storage.json` (owner-only) and given to a glass whose page is missing either. Only for sites made for many devices signed in at once (a pairing token, like vmux's). Leave it off for sites that rotate refresh tokens or keep sign-in elsewhere (IndexedDB): glasses would log each other out, or restore half a sign-in. Signing out in one glass doesn't reach the shared copy; **Reset data** clears it. |

Pages an app embeds from its `network` origins are third-party inside the glass, so browsers
would drop their `SameSite` cookies (a login cookie on a WebSocket, say). For declared origins
only, the glass keeps the cookies those servers set and sends them back to the same origin, as if
the page were first-party. Nothing changes for any other site.

Settings has a **Reset data** link for apps with `network` or `storage`: it clears the app's
storage and the storage and cookies of its declared origins (e.g. to log an embedded page out).

Everything else, for every app, stays denied. Apps with these permissions can talk back to other
services (a voice app, say): that's allowed as the app's own choice. Only `twoWay` reaches back
into the Claude session, and only through the hooks above; the glass core stays one-way.

## Turning apps off

Settings lists every app with a switch. A turned-off app's windows close, session events leave it alone,
it disappears from Claude's catalog and instructions, and commands to it fail with a message
telling Claude not to use it.

## Trust

`core.js` runs with full Node access in the glass process, like any plugin you install. Only
install apps you trust. The view is sandboxed.

## Bridge reference (v1)

Messages are `postMessage` objects with `glass: 1`.

| Direction | `kind` | Fields |
|---|---|---|
| view → glass | `ready` | (sent by the SDK on load) |
| glass → view | `props` | `props: { id, meta, state, size, session, settings, stored, shared, theme }` |
| view → glass | `run` | `command`, `args` (view commands only) |
| view → glass | `store` | `values` (stored values the manifest declares) |
| view → glass | `host` | `service: 'lightbox' \| 'aspect'`, `args` |
| glass → view | `frame` | `source`, `data` (live frames, e.g. the browser stream) |
