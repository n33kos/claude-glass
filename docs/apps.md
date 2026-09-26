# Writing Claude Glass apps

Every window in Claude Glass is an app, and every app, built-in or yours, uses the same format.
Drop a folder into `~/.claude/claude-glass/apps/`, restart the glass, and it's there.

```
claude-glass apps new my-app      # starter app in ~/.claude/claude-glass/apps/my-app
claude-glass apps copy diff       # copy a built-in to modify it (yours overrides it)
claude-glass apps                 # what's installed, and why a broken app didn't load
claude-glass close && claude-glass open   # restart the glass to pick up changes
```

The glass is one-way: Claude shows, the user watches. An app displays things; its view can
change how things are viewed (select, page, filter) but has no way to send anything to Claude.

## The folder

```
my-app/
  glass-app.json   manifest
  core.js          state logic (CommonJS)
  view.html        what the window shows (optional; runs in a sandboxed frame)
  guide.md         instructions for Claude (optional)
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
| `singleton` | one window, whose id is `type`. Otherwise `claude-glass new my-app` makes more |
| `commands` | what Claude can run: `claude-glass app <id> <command> --key value`. Flags arrive as `args` |
| `view: true` / `viewCommands` | commands the view may run too (view-only changes) |
| `internal` | commands hidden from Claude's catalog (used by your view or hooks only) |
| `autoOpen` | open the window the first time `onHook` creates it |

### `core.js`

Pure functions over your app's own state. They run in the glass's main process (plain Node).
State is saved with the session and restored when the glass reopens.

```js
exports.init = () => ({ items: [] });

exports.command = (state, command, args) => {
  if (command === 'set') return { ...state, text: String(args.text ?? '') };
  throw new Error(`my-app: unknown command "${command}"`); // shown to Claude
};

// Optional: every Claude Code hook payload (PreToolUse, PostToolUse, UserPromptSubmit, ...).
// Return the same object when nothing changes. A singleton is created the first time this
// returns something new.
exports.onHook = (state, payload) => state;
```

Keep it pure: no I/O, no timers, no globals. Return new objects instead of mutating. Keep
state small (it's saved as JSON); cap lists.

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

The stylesheet gives you the glass's tokens: `--ink`, `--ink-dim`, `--ink-faint`, `--sky`,
`--ok`, `--warn`, `--bad`, `--line`, `--sans`, `--mono`. The page background is transparent so
the window's glass shows through.

Images the glass stored (e.g. from `claude-glass show`) are at `glass-file://f<absolute path>`.

The built-in apps are written in React with `src/sdk/react.tsx` (`mount(View)`), which wraps
the same bridge. Their sources come along when you copy one (`src/`).

### `guide.md`

Appended to the instructions Claude gets when the glass opens (up to 1,500 characters). Say
when to use your app and which commands to run. This is how you shape Claude's behavior with
your app.

## Permissions

By default a view has no network, no microphone and no storage. An app that needs them says so
in its manifest; the user sees what each app can use in Settings (and in `claude-glass apps`).

```json
"permissions": {
  "network": ["http://127.0.0.1:3100", "ws://127.0.0.1:3100"],
  "microphone": true,
  "storage": true
}
```

| Permission | What the view gets |
|---|---|
| `network` | fetch/WebSocket/scripts/images/frames to exactly these origins (http(s)/ws(s), no wildcards). Servers still apply their own CORS. |
| `microphone` | `getUserMedia({ audio: true })` (never the camera), for the view and for pages it embeds from its `network` origins (give the inner iframe `allow="microphone"`). macOS will also ask the user once. |
| `storage` | its own persistent `localStorage`/IndexedDB, at origin `glass-app://<type>` |

Everything else, for every app, stays denied. Apps with these permissions can talk back to other
services (a voice app, say): that's allowed as the app's own choice, but it never reaches the
glass core, which stays one-way.

## Turning apps off

Settings lists every app with a switch. A turned-off app's windows close, hooks leave it alone,
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
| glass → view | `props` | `props: { id, meta, state, size, session }` |
| view → glass | `run` | `command`, `args` (view commands only) |
| view → glass | `host` | `service: 'lightbox' \| 'aspect'`, `args` |
| glass → view | `frame` | `source`, `data` (live frames, e.g. the browser stream) |
