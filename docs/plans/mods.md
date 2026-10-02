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

- [x] **Manifest permission** `"permissions": { "twoWay": true }`, shown in Settings and
      `claude-glass apps`. A two-way app's view commands run only from the glass's own window
      (`GlassCore.dispatch(action, 'ui')`); the socket (CLI, Claude, the mod) can't run them, so
      nothing but the user approves anything
- [x] **Action app** (`action`, built-in, two-way): a card per permission prompt, brought to the
      front, with the tool, a summary, the detail (a diff for Edit/Write, a long command, a URL)
      and Allow / Always allow (when Claude Code offers rules) / Deny. Answered cards go after a
      moment, and the window with them (`keepAnswered` keeps them); settings `approvals`,
      `keepAnswered`, `holdMinutes`
- [x] **Racing the terminal**: the mod answers `classic.PermissionRequest` (fired exactly when the
      prompt would show, after rules and the auto-mode classifier). While it waits it draws the
      same choices in the band above the prompt (1 Allow · 2 Always · 3 Deny · 4 Ask here);
      whichever is answered first wins and the other side is told. "Ask here", a timeout
      (`holdMinutes`), an interrupt, or no glass: Claude Code's own prompt. The wait polls
      `claude-glass action wait <id> --ms 700` (time inside `$` calls is free), so no server
- [ ] App questions: any two-way app can raise one (Phase 3)
- [ ] Questions (AskUserQuestion): the experiment below
- [x] **Interrupt** (`interruptButton`, off by default): a Stop button in the top bar while
      Claude works. The glass queues a control (only its own window can, over IPC); the mod's
      background loop collects it with `claude-glass watch` (blocks on the socket up to 20s; only
      runs while the button is on) and calls `$.turn.abort({ turnId })`. Checked live: a headless
      session's turn ended `aborted` within a second of Stop, its running command stopped
- [x] Waiting state comes from exact events (`classic.PermissionRequest`, AskUserQuestion)

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

- [x] AskUserQuestion on the glass (`app.action.questions`, off by default): the mod holds the
      `tool.call`, the Action app shows each question with its options as buttons, multi-select
      toggles, and a field for the user's own words; the answers come back as the tool's
      `{ result: { questions, answers } }`. The read-only question card steps aside meanwhile
- [x] Racing the terminal: `$.ui.ask` can't be withdrawn once shown, and Claude Code's own
      prompt and dialog can't either, so the mod draws its own choices in the band above the
      prompt (its own, so it can take them away). For a question: one question with one choice
      to make shows its options there (1–4); otherwise just "Answer here instead". Either way the
      way back to Claude Code's own dialog stays one key away
- [x] The same for permission cards (Phase 2)
- [ ] Decide after using it: keep questions off by default, or turn them on

## Phase 3 — Two-way apps: the mods interface for app authors

- [x] An app's `core.js` may export `register(on)` (two-way apps only; a one-way app that does
      isn't loaded), mirroring mods: `on(event, matcher?, async (glass, e, next) => …)` over
      `tool.call` and `prompt.submit` (before Claude Code acts; no "after" across the process
      boundary). `src/core/apphooks.ts`. The glass tells the mod which tools are hooked in its
      reply to each event batch, so other tool calls cost no CLI call; the mod forwards with
      `claude-glass hook <event>`. Checked live: an app refused a command, Claude read why
- [x] `glass` handle: `stored` / `store(patch)`, `ask(question, options)` (an Action card; the
      wait doesn't count toward the handler's 10s)
- [ ] More events and handle methods when an app needs them (`tool.check`, `turn.*`,
      `prompt.submit` from a handler, `turn.abort`)
- [x] **Claude asks the glass**: the mod registers `mcp__glass__ask` (question, options) in
      sessions that start with a glass open → an Action card → "The user answered: …". No
      preview field: Claude points at windows already on the glass
- [x] **Point and ask**: "Ask about this" on a change in Changes; `glass.host('attach', …)` for
      built-in and two-way views. Attachments ride the next `prompt.submit` as `context` (the
      transcript stays clean), shown as chips in the top bar until then; only the glass window
      can attach. Checked live: Claude read an attached note
- [ ] Point and ask from more places: lines in a file, a diagram node, an image region
- [x] **Ask Claude from the glass** (`askBox`, off by default): a field in the top bar; the mod
      collects it with `claude-glass watch` and `$.prompt.submit({ text, asUser: true })`s it
- [x] docs/apps.md: "Two-way apps"; a sample two-way app (`test/fixtures/apps/guard`)

## Phase 4 — Prompt shaping

- [x] The guide follows the settings without a restart. This build can't add a system prompt
      section (`prompt.section` only rewrites Claude Code's own), so: the glass remembers the
      guide it last gave (session start, `open`), and when the current one differs (a setting
      changed, or the glass opened mid-session) the next prompt carries it as context, once.
      Unchanged, nothing is added, so the prompt cache stays warm
- [x] `viewContext` (off by default): each prompt carries what's on the glass now (the
      `claude-glass view` text, `src/core/viewtext.ts`); it costs tokens
- [ ] When `prompt.compose` reaches this account's build: the guide as a system section instead

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
