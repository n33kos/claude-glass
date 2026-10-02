// Two-way apps' hooks on the Claude session (`register(on)` in an app's core, like a Claude Code
// mod's). The glass mod forwards the events some app asked for: `claude-glass hook <event>` with
// the event on stdin, answered with what to do. A handler runs before Claude Code acts: it passes
// the event on (`next(e)`, maybe changed) or answers it (`{ deny }`, `{ result }`, `{ drop }`).
import { APPS } from '../apps/registry';
import type { AppDef, AppHookEvent, AppHookGlass, AppHookHandler } from '../apps/types';

export const APP_HOOK_EVENTS: readonly AppHookEvent[] = ['prompt.submit', 'tool.call'];
const HANDLER_MS = 10_000; // a handler's own time (an ask waits on the user, so it doesn't count)

export interface AppHook { app: string; event: AppHookEvent; matcher: Record<string, unknown>; fn: AppHookHandler }

/** Collect the hooks of every two-way app that registers some (a broken register is skipped). */
export function collectHooks(disabled: readonly string[] = []): { hooks: AppHook[]; errors: Record<string, string> } {
  const hooks: AppHook[] = [];
  const errors: Record<string, string> = {};
  for (const app of Object.values(APPS)) {
    if (!app.register || disabled.includes(app.type)) continue;
    if (!app.permissions?.twoWay) { errors[app.type] = 'register(on) needs "permissions": { "twoWay": true }'; continue; }
    try {
      app.register((event, a, b) => {
        if (!APP_HOOK_EVENTS.includes(event)) throw new Error(`can't hook "${event}" (hookable: ${APP_HOOK_EVENTS.join(', ')})`);
        const fn = (typeof a === 'function' ? a : b) as AppHookHandler | undefined;
        if (typeof fn !== 'function') throw new Error(`on("${event}") needs a handler`);
        hooks.push({ app: app.type, event, matcher: typeof a === 'function' ? {} : a, fn });
      });
    } catch (e: any) {
      errors[app.type] = e?.message ?? String(e);
    }
  }
  return { hooks, errors };
}

/** A matcher's fields against the event's: a value, a list of values, or a pattern. */
export function matches(matcher: Record<string, unknown>, e: Record<string, unknown>): boolean {
  return Object.entries(matcher).every(([k, want]) => {
    const got = e[k];
    if (want instanceof RegExp) return typeof got === 'string' && want.test(got);
    if (Array.isArray(want)) return want.includes(got);
    return got === want;
  });
}

/** What the mod should forward: per event, the tools a tool.call hook matches ('*' = any). */
export function subscriptions(hooks: AppHook[]): Record<string, string[]> {
  const out: Record<string, Set<string>> = {};
  for (const h of hooks) {
    const set = (out[h.event] ??= new Set());
    const tool = h.matcher.tool;
    if (h.event !== 'tool.call' || tool === undefined || tool instanceof RegExp) set.add('*');
    else for (const t of Array.isArray(tool) ? tool : [tool]) set.add(String(t));
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.has('*') ? ['*'] : [...v]]));
}

const PASS = Symbol('pass');

/**
 * Run an event through the hooks that match it, in app order. What comes out: `{ e }` (passed
 * on, maybe changed) or `{ answer }` (a handler answered it).
 */
export async function runHooks(hooks: AppHook[], event: AppHookEvent, e: Record<string, unknown>, glassFor: (app: AppDef) => AppHookGlass):
  Promise<{ e: Record<string, unknown> } | { answer: unknown }> {
  const chain = hooks.filter((h) => h.event === event && matches(h.matcher, e));
  const step = async (i: number, ev: Record<string, unknown>): Promise<any> => {
    if (i >= chain.length) return { [PASS]: true, e: ev };
    const h = chain[i];
    const app = APPS[h.app];
    if (!app) return step(i + 1, ev);
    let called = false;
    const next = (changed: unknown) => { called = true; return step(i + 1, changed && typeof changed === 'object' ? changed as Record<string, unknown> : ev); };
    try {
      const out = await withTimeout(Promise.resolve(h.fn(glassFor(app), ev, next)), HANDLER_MS, h);
      if (out === undefined && !called) return step(i + 1, ev); // nothing said: pass it on
      return out;
    } catch {
      return called ? { [PASS]: true, e: ev } : step(i + 1, ev); // a broken handler is skipped
    }
  };
  const out = await step(0, e);
  return out?.[PASS] ? { e: out.e } : { answer: out };
}

// The wait on an ask belongs to the user, not the handler: while one is open, the clock waits.
let asking = 0;
export async function whileAsking<T>(p: Promise<T>): Promise<T> {
  asking++;
  try { return await p; } finally { asking--; }
}

function withTimeout<T>(p: Promise<T>, ms: number, h: AppHook): Promise<T> {
  return new Promise((resolve, reject) => {
    let t: NodeJS.Timeout;
    const arm = () => { t = setTimeout(() => (asking > 0 ? arm() : reject(new Error(`${h.app}: ${h.event} hook took over ${ms / 1000}s`))), ms); };
    arm();
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
