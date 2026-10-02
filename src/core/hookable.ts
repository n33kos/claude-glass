// Which Claude Code mod events two-way apps may hook: all of them, as Claude Code names them now
// and later (the glass mod hooks `*` and forwards whatever an app subscribed to), except a few.
// tool.call and prompt.submit come in the glass's own shape (docs/apps.md); every other event is
// passed through as Claude Code's mod sees it (its types: claude-code.d.ts), and a handler's
// answer is the event's result.
export const SHAPED_EVENTS: readonly string[] = ['prompt.submit', 'tool.call'];

// Not hookable from an app: streams (a generator, not one answer), drawing (elements aren't JSON),
// the engine's own assembly, and the glass mod's transport (process.run and fs.exists carry every
// `claude-glass` call; hooking them would loop through the glass).
export const NOT_HOOKABLE: readonly string[] = [
  'turn.step', 'process.spawn', 'engine.create', 'ui.render', 'ui.resolve', 'process.run', 'fs.exists',
];

const EVENT_NAME = /^[a-z][a-zA-Z]*(\.[a-zA-Z]+)+$/;

export function isHookable(event: string): boolean {
  return EVENT_NAME.test(event) && !NOT_HOOKABLE.includes(event) && !event.startsWith('telemetry.');
}
