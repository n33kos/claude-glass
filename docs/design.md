# Graphite Mono: the Claude Glass design system

Claude Glass is a small OS: it frames apps it doesn't control. So the system is built the way OS
design systems are: **the chrome recedes and has no hue**, apps get **semantic roles** (not raw
values), and **color is reserved for meaning**: status, an app's own content and icon, and the
signal layer. Everything lives in one file, [`src/sdk/tokens.css`](../src/sdk/tokens.css), which
the shell and every app view load (custom apps get it through the SDK stylesheet).

## Principles

1. **The chrome recedes.** Windows, the top bar, the launcher and docks are neutral graphite. No hue.
2. **One accent, and it's white** (black in light mode): selection, focus, the primary action.
3. **Color means something.** A status mark, an app's own content or icon, or a signal. Nothing else.
4. **Roles, not values.** Use `--text-2`, not `#9a9ba2`. A theme is one block of overrides.
5. **One radius, derived.** Windows set `--radius-lg`; inside a window's padding, radius − padding.
6. **One material.** Windows are one translucent glass; popovers are solid. Glass never stacks on glass.
7. **Three weights, one family.** Geist and Geist Mono (bundled), 400/500/600. Never heavier.
8. **Apps keep their own identity.** Their icons and content can be any color; the frame holds them.

## Tokens

Three layers. Only `tokens.css` uses primitives; everything else uses roles and scales.

**Primitives**: `--gray-0` … `--gray-12` (true gray), and the hues `--blue --green --red --amber
--violet --pink --teal --orange`, which exist for status, charts and signals only.

**Roles**

| Role | Tokens | Use |
|---|---|---|
| Text | `--text-1` `--text-2` `--text-3` `--text-disabled` `--text-on-accent` `--text-link` | primary, secondary (labels), tertiary (hints); links are underlined text |
| Surfaces | `--surface-base` `--surface-chrome` `--surface-bar` `--surface-overlay` `--surface-raised` `--surface-sunken` `--surface-hover` `--surface-pressed` `--surface-selected` | back to front; a window is `rgba(var(--glass-rgb), var(--glass))`, written where it's used |
| Lines | `--border-subtle` `--border` `--border-strong` `--border-focus` | hairlines, one step per emphasis |
| Accent | `--accent` `--accent-soft` `--accent-line` `--accent-text` | selection, focus rings, the one primary action per view |
| Status | `--ok --warn --bad --info`, each with `-soft` `-line` `-text` | a result or a state. Prefer a 6px mark or a word; soft fills are for the rare verdict |
| Diff | `--add-bg` `--del-bg` | added/removed lines |
| Charts | `--cat-1` … `--cat-6` | telling series apart, in order |
| Signals | `--signal-look --signal-wait --signal-done --signal-fail --signal-progress --signal-strength` | the signal layer only |

**Scales**

| Scale | Tokens |
|---|---|
| Type | `--font-sans` `--font-mono`; `--text-size-2xs` 10.5 · `xs` 11 · `sm` 12 · `md` 13 (body) · `lg` 14 · `xl` 16 · `2xl` 20 · `3xl` 26; `--weight-regular/medium/semibold`; `--leading-tight/normal/relaxed`; `--tracking-tight/caps` |
| Space | `--space-0` 2 · `1` 4 · `2` 6 · `3` 8 · `4` 12 · `5` 16 · `6` 20 · `7` 24 · `8` 32 |
| Radius | `--radius-xs` 4 (badges) · `sm` 6 (controls, rows) · `md` 8 (cards in a window) · `lg` 12 (windows, popovers) · `xl` 16 (outside windows only) · `pill` |
| Depth | `--shadow-1` (chips) · `--shadow-2` (windows) · `--shadow-3` (menus, drags) · `--inner-highlight` |
| Motion | `--ease`; `--dur-1` 120ms (hover, press) · `--dur-2` 200ms (fades) · `--dur-3` 320ms (layout) |

Old names (`--ink`, `--ink-dim`, `--line`, `--sky`, `--sans`, `--mono`, `--radius-win`) still work.

## Themes

`theme` in Settings: dark (default), light, or system. The shell sets `data-theme` on its page and
passes it to app frames in their props; the SDK sets it on the frame's page, so tokens switch on
their own. A custom app that uses roles gets light mode for free.

## Components

- **Buttons**: primary = `--accent` fill with `--text-on-accent`, one per view; secondary =
  `--surface-hover`; ghost = no fill, `--text-2`. 28px tall, `--radius-sm`. Hover steps the fill up
  one level; press scales to 97%.
- **Rows**: `--radius-sm`; hover `--surface-hover`; selected `--surface-selected` (a white fill, not a color).
- **Status**: a 6px mark, a word, or (at most once per view) a verdict in the status color.
- **Menus and popovers**: `--surface-overlay`, `--border-strong` hairline, `--shadow-3`.
- **Labels**: all caps, `--text-size-2xs`, `--weight-medium`, `--tracking-caps`, `--text-3`.

## The signal layer

With no color in the chrome, the wallpaper light is the one place color can speak. Claude uses it as
a small fixed vocabulary (`claude-glass signal`), and the glass adds the automatic ones:

| Signal | Looks like | Sent by |
|---|---|---|
| Waiting on you | amber rises from the bottom edge and breathes | automatic (a question or permission) |
| Alert | red flickers behind the window that broke, its edge lit | `signal alert <window>`, or a failing test run |
| Spotlight | blue gathers behind one window, its edge lit | `signal spotlight <window>`: "look here" |
| Done | one soft green bloom | automatic, after a turn of 30s or more |
| Progress | a pale light at the front of a hairline bar, with a label | `signal progress <0..1> --label L` |

Rules: **one at a time** (waiting wins, then alert, spotlight, done, progress); **everything decays**
to graphite within seconds (waiting and progress hold until they're over); **each color means one
thing**; **never the only cue** (a signal repeats what the conversation or a window already says).
Turn it off with `signals: false`; reduced motion shows the end state without animating.

## For app authors

Load the SDK stylesheet (`glass-app://sdk/glass-app.css`) and use roles and scales. Your content and
icon can be any color; keep your own chrome (bars, buttons, lists) on the tokens so the app sits in
the frame like the built-ins. See [apps.md](apps.md).
