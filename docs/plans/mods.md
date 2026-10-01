# Plan: Claude Glass as a Claude Code mod

Claude Code mods (function hooks: `register(on)`, middleware over every event, a `$` API) let
the glass see events exactly, act on them in-process, and, when an app is allowed to, talk back.
This plan covers everything we'd build on that, in phases. Each phase ships on its own.

**North star, revised (2026-10-01).** The core stays one-way: Claude shows, the user watches.
Two-way is an opt-in **per-app permission**. A two-way app can answer approvals and questions,
add context to a prompt, or start/stop a turn. It never changes how the core works, and every
two-way path falls back to Claude Code's own UI when the glass is closed, slow or absent.

## Phase 0 — Foundations

- [x] Claude Code 2.1.287; mods are on for this account (a server flag; no env override needed —
      `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` does nothing in 2.1.287). Minimum in the README
- [x] North star reworded in `CLAUDE.md`, `README.md`, `docs/apps.md` and `ROADMAP.md`:
      "primarily one-way; two-way is an app's opt-in permission"; CLI first, no servers
- [x] **The glass mod replaced the settings hooks.** `hooks/hooks.json` is just
      `"modules": ["./glass-mod.ts"]` (TypeScript Claude Code loads as is; no build step, so it
      works before the first build). The old path is deleted:
      - `scripts/hook-forward.sh`, `scripts/tool-reminder.sh`, every `hooks` entry: gone
      - start-up: `classic.SessionStart` (startup, clear, resume, compact) runs
        `claude-glass session-start` (bind, open on `autoStart`, the guide); `session.start`
        covers a hot reload. The guide goes in through `prompt.context` (a block with the first
        message of each conversation, like the old SessionStart context)
      - the socket's `hook` op and `src/core/hooks.ts` → an `event` op (a batch) and
        `src/core/events.ts` (`GlassEvent` → actions); apps' `onHook` → `onEvent` (an app still
        exporting `onHook` is refused with a pointer to the docs)
      - streaming: `turn.step`'s text chunks; the mod sends each block's text so far
      - waiting: `classic.PermissionRequest` (the prompt is really shown) and AskUserQuestion
      - background agents finish on their own `turn.complete` (`agentId`) → `agent.end`
      - `toolReminders` → the mod (`tool.call` on Bash, a context line, never a refusal)
      - an image Read's base64 is stripped before it's sent (the glass copies the file)
      - `test/fixtures/mod-events.ndjson`: a real session recorded through the mod
- [x] **Transport: the CLI, nothing new running.** `$.process.run([root/bin/claude-glass, 'event',
      '--session', id])` with the events as NDJSON on stdin. One call in flight at a time, in
      order, carrying everything queued since the last (streamed text replaces its queued copy).
      No socket → the CLI isn't run at all
      - Later (Phase 2): `claude-glass action wait <id>` for held decisions
      - Only if 40 ms ever hurts: `$.http.fetch` with `socketPath` to the same socket
- [x] **Mods required**: `claude-glass open` warns when the mod never ran in the session (it
      writes `<runtime>/<session>.mod` at session start)
- [x] The glass's top bar says so too ("Not connected"), until any event arrives
- [x] Vitest unit + integration tests on recorded events, the CLI's `event` and `session-start`;
      e2e seeds through `claude-glass event`. Verified live: a headless `claude -p` session with
      `--plugin-dir` filled every window, got the guide and the reminder
- [ ] Mod unit tests with `claude plugin test` (`hooks/*.test.ts`)
- [x] The plugin is renamed `glass` (`claude-` names are reserved); CLI, repo, app keep theirs
- [ ] At release: rename the entry in `~/claude-plugins/.claude-plugin/marketplace.json` to
      `glass` in the same push (not before: the installed `claude-glass@n33kos` would break)
- [x] The glass's own "mods" are "apps" now (`src/core/customApps.ts`, the `apps` op,
      `test/fixtures/apps`); "mod" only means the Claude Code mod

## Phase 1 — Exact, deterministic signals and attention (one-way)

Events, not Claude's memory, drive the signal layer and window order, so they're right every time.

| Event | Gives us |
|---|---|
| `turn.start` / `turn.complete` | exact turn ids, the answer, how long it took, whether it was aborted |
| `turn.step` | each model request (a heartbeat while working) and its token usage |
| `tool.call` (awaiting `next`) | the call and its result together, `isError`, refusals |
| `tool.check` | the real permission decision (allow / ask / deny): exact "waiting on you" |
| `session.measure`, `$.session.usage()` | context %, rate limits, cost |
| `session.compact` | compaction starting |
| `agent.spawn` | subagents with their model |

- [x] **Attention settings** (the user chooses; Claude no longer has to remember): `followEdits`,
      `followPlans`, `followTests` (replaces `signalFailed`; default `light`), `followWeb`,
      `followImages`, `followAgents`, each `off | light | front | both | focus` (focus also shows
      desktop 1). Applied in `src/core/events.ts` as reducer actions; only windows on screen move
      (a closed one stays closed; docked ones are lit, not moved; history mode never moves).
      With signals off, light means nothing. The guide lists what's on so Claude doesn't repeat it.
      Settings → Attention
- [ ] Waiting → the Action app (Phase 2)
- [x] **Turn progress bar** (`turnProgress`, default on): a thin white line along the bottom while
      a turn runs. It sweeps, brightens on each model request (the mod's `step` event), fills by
      tasks done while Claude works through a list, and pauses while it waits on you
- [x] **Done/failed exactness**: `session.lastTurn` from `turn.complete` (duration, reason): the
      done bloom for a long answered turn; an error or refusal lights the conversation red
- [x] **Turns everywhere**: terminal entries carry their turn, each turn starts with a divider
      showing the prompt, and a subagent's calls are set in; Changes revisions carry their turn,
      with an "All / This turn" switch (the conversation was already per turn)
- [ ] Later, if wanted: step through one turn's edits in order (Changes already flips revisions)
- [x] **Context gauge** (`contextGauge`): the mod's `session.measure` → a `usage` event → a ring
      and percent in the top bar, amber from 85%; hover for tokens, cost, plan limits

## Phase 2 — The Action app and two-way permissions

- [ ] **Manifest permission** `"permissions": { "twoWay": true }`, shown in Settings and
      `claude-glass apps` like network/microphone; off → the app can't answer anything
- [ ] **Action app** (`action`, built-in, two-way, docked bottom-right by default). A card per
      pending request:
      - **Permission**: the mod's `tool.check` hook awaits `next(e)`; when the decision is
        `ask`, it shows the card with the tool, its input (a diff preview for Edit/Write, the
        command for Bash) and Allow / Deny / Allow-always
      - **App questions**: any two-way app can raise one (Phase 3)
      - Questions (AskUserQuestion) come in once the experiment below works out
      - After an answer the card fades out (`action.keepAnswered: false`) or stays as a
        history row
- [ ] The terminal must keep working for voice/tmux users: the permission prompt is not a render
      site, so we decide through `tool.check`, never by redrawing it, and fall back to Claude
      Code's own prompt (see the experiment below for racing the two)
- [ ] **Interrupt**: a Stop button in the top bar while Claude works → `$.turn.abort()`
      (setting `interruptButton`, off by default)
- [ ] Waiting state comes from these exact events (no more inferring it from notifications)

## Persistent app state (`stored`)

### What mods give us, researched

| Where | Lives until | Catch |
|---|---|---|
| a module variable | the mod reloads | ephemeral only |
| `$.state` | the session ends, or `/clear`, `/resume`, `/branch` reset it to defaults. Survives a mod reload. Reactive (a render that reads it redraws) | `session.start` does **not** fire again after `/clear`; only `classic.SessionStart` with `source: clear \| resume \| fork` does, so anything copied in must be copied again there |
| `$.store` | until deleted, or no session touches it for `cleanupPeriodDays` | **one** JSON file per plugin (`~/.claude/plugins/store/`), shared by every session on the machine, **4 MiB total**; `get`+`set` isn't atomic (sessions race) |
| the glass's `state.json` (today) | the glass: per session, or per folder in folder scope | app state is per window, so a new session (session scope) starts empty |

App cores run in the glass, not in the mod, so app data shouldn't live in `$.state`/`$.store`:
the 4 MiB budget would be shared by every app and session, and `$.state` is wiped by `/clear`.
The glass already writes state to disk; what's missing is **scope** (outliving a session) and a
**declared, uniform API**. The mod keeps `$.state` for its own mirror (below).

### The pattern

Persistent values are reducer state like everything else, declared with a scope in the manifest.
The host mirrors each scope to disk; apps never do I/O.

```json
"stored": {
  "pinned":   { "scope": "project", "default": [] },
  "lastTab":  { "scope": "session", "default": "all" },
  "seenTips": { "scope": "global",  "default": 0 }
}
```

| Scope | Shared by | Saved in |
|---|---|---|
| `session` | this glass | `sessions/<id>/state.json` (as now) |
| `project` | every glass in this project folder: survives `/clear`, restarts, resumes | `~/.claude/claude-glass/projects/<folder id>/stored/<type>.json` |
| `global` | every glass | `~/.claude/claude-glass/stored/<type>.json` |

Built (docs/apps.md, "Stored values"):

- [x] **State**: `GlassState.stored[type][key]`; reads are synchronous, defaults filled in
- [x] **Writes**: reducer actions `stored.set` / `stored.load` / `stored.reset`; the server
      (`src/core/stored.ts`) mirrors project and global keys to one JSON file per app, atomically
- [x] **Another glass changed it**: a folder watch plus a 2-second recheck (a watch can miss
      changes on macOS) loads the file again, so every open glass agrees; last write wins
- [x] **Cores**: `command(state, name, args, ctx)` / `onEvent(state, event, ctx)` get
      `ctx.stored`; returning `ctx.store(nextState, { key: value })` writes (typed as the state;
      the reducer recognizes the write)
- [x] **Views**: `stored` in props; `glass.store({ key: value })` over the bridge (`store` in React)
- [x] **CLI**: `claude-glass stored <type> [set <key> <json> | reset [key]]`; Settings → Apps
      shows how many values an app keeps, with Reset
- [x] **Limits**: JSON, 256 KB per app per scope, declared keys only
- [ ] Two-way handlers (Phase 3) get the same `ctx`
- [ ] The mod's own mirror in `$.state` (attention settings, subscriptions), only once the mod
      needs something on every event; today it needs nothing beyond the session start

## Experiment — Question cards

Separate from the Action app's first version; we try it and keep what works.

- [ ] AskUserQuestion on the glass: its `tool.call` → the question and options as buttons on an
      Action card; the answer comes back as the tool's `{ result }`
- [ ] Race the terminal: can the mod show its own `$.ui.ask` (or let Claude Code's dialog show)
      and withdraw it when the glass answers first, and the reverse? If not: hold for the glass
      for `action.holdSeconds` (default 0 = off), then fall back to the terminal
- [ ] The same for permission cards
- [ ] Decide: glass and terminal side by side, glass first with a fallback, or not at all

## Phase 3 — Two-way apps: the mods interface for app authors

- [ ] An app's `core.js` may export `register(on)` (two-way apps only), mirroring mods:
      `on(event, matcher, async (glass, e, next) => …)` over the same event names
      (`tool.call`, `tool.check`, `prompt.submit`, `turn.*`, `session.*`). The glass mod
      forwards only events some two-way app subscribed to (it fetches the subscription list at
      `session.start` and when apps change), so other tool calls cost no CLI call
- [ ] `glass` mirrors a safe subset of `$`: `ask` (a card in the Action app), `state`,
      `prompt.context(text)`, `prompt.submit(text)`, `turn.abort()`, `toast`
- [ ] **Claude asks the glass**: a mod tool `mcp__claude-glass__ask` (question, options,
      optional HTML/image preview) → an Action card → the choice as the result. For "which of
      these mockups?"
- [ ] **Point and ask**: select a diff hunk, lines in a file, a diagram node, an image region →
      "Attach to next prompt"; `prompt.submit` adds it as `context` (Claude reads it, the
      transcript stays clean). A chip in the top bar shows what's attached
- [ ] **Ask Claude from the glass**: an input that `$.prompt.submit({ text, asUser: true })`s
      (waits until idle)
- [ ] docs/apps.md: the two-way section, bridge v2 messages, a sample two-way app

## Phase 4 — Prompt shaping

- [ ] The guide as a system prompt section is done in Phase 0. Here: make it follow settings
      without a restart, changing only when the guide's inputs change (the prompt cache)
- [ ] Optional per-turn context: the current `view` summary in `prompt.submit` context, so
      Claude re-ranks from what's really on screen (setting; it costs tokens)

## Not now

Decided against for the time being; revisit only if there's a clear need.

- **Enforcing tool use** (refusing `sed -i`, heredoc writes): `sed` across many files is
  legitimately fast, and refusing it would slow Claude down. `toolReminders` stays a reminder
- **Glass tools instead of the CLI** (`mcp__claude-glass__*`): the CLI is the one interface for
  people, Claude and the mod alike
- **The glass inside Claude Code's terminal**: `/glass` mod commands, an AbovePrompt band, toasts

## Later

- vmux convergence: much of what vmux does (activity, waiting, relay) could come from these
  events; an API-based voice integration could replace parts of it. Its own plan, another day
- Glass-to-glass: `$.session.send` between sessions, a multi-session overview
- Side questions with `$.model.complete / fork / classify`: window titles, a "what Claude is
  doing" card, topic-based re-ranking
- `session.attach` / `detach`: find out what "another app connects to the session" offers

## Risks and open questions

- Latency: a forwarded event costs one CLI call (~40 ms); forward only what's subscribed and
  don't await one-way forwards
- Racing the terminal prompt (Phase 2 spike) decides how the Action app feels
- Mods run before settings hooks: a mod that answers `tool.call` skips other plugins'
  PreToolUse hooks. Ours always calls `next` unless the user answered
- Prompt cache: anything we inject that changes per request costs money; keep it stable
- Rollout: mods are off by default for some accounts and can be blocked by an org. We require
  them anyway; the glass says clearly when the mod isn't loaded
