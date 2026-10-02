// The shared app contract (strategy pattern). Every app implements AppDef; the window
// manager and CLI treat all apps identically. Core side only: no React, no DOM.

export type Args = Record<string, unknown>;

export interface CommandSpec {
  usage: string; // e.g. "set --text <markdown> | --file <path>"
  help: string;
  view?: boolean; // the app's own view may run it (view-only changes: selecting, paging)
}

export interface AppDef<S = any> {
  type: string;
  title: string; // default window title
  icon: string; // single glyph for dock/title bar (fallback when there's no image icon)
  iconFile?: string; // image icon in the app's folder (served as glass-app://<type>/<file>)
  singleton: boolean; // singleton apps use their type as instance id
  description: string;
  commands: Record<string, CommandSpec>;
  init(): S;
  /**
   * Apply a command. Must be pure: return new state, throw Error on bad input. `ctx.stored` reads
   * the app's persistent values; return `ctx.store(nextState, { key: value })` to write some.
   */
  command(state: S, command: string, args: Args, ctx?: AppContext): S;
  /** Optional: see every session event (src/core/events.ts, GlassEvent) and update state (pure). Singletons are created on first change. */
  onEvent?(state: S, event: any, ctx?: AppContext): S;
  stored?: Record<string, StoredSpec>; // persistent values the app keeps, by scope (manifest "stored")
  /**
   * Two-way apps only (permissions.twoWay): hooks on the Claude session, like a Claude Code mod's
   * `register(on)`. The glass mod forwards the events they ask for (src/core/apphooks.ts).
   */
  register?(on: AppOn): void;
  autoOpen?: boolean; // open the window the first time onEvent creates the instance
  internal?: string[]; // commands only events/the view use; hidden from Claude's catalog
  viewCommands?: string[]; // commands the app's view may run (plus any CommandSpec with view: true)
  guide?: string; // instructions for Claude, appended to the glass guide
  settings?: Record<string, SettingSpec>; // the app's own user settings (Settings → Apps, CLI, view props)
  permissions?: AppPermissions;
  source?: 'builtin' | 'user';
  dir?: string; // app folder: its view.html is served into a sandboxed frame
}

/**
 * Persistent app values ("stored"), declared in the manifest with a scope:
 *   session  this glass (saved with it)
 *   project  every glass in the project folder: survives /clear, restarts, resumes
 *   global   every glass
 * Values are JSON; ephemeral values belong in the app's own state or plain variables.
 */
export type StoredScope = 'session' | 'project' | 'global';
export interface StoredSpec { scope: StoredScope; default: unknown }

/**
 * Two-way app hooks (`register(on)` in core.js), shaped like a Claude Code mod's. The glass mod
 * forwards these events; a handler passes the event on (`next(e)`, maybe changed), or answers:
 *   prompt.submit  e: { text, context: string[] }   next({ ...e, text | context }) or { drop: reason }
 *   tool.call      e: { tool, input, agentId? }      next(e) or { deny: reason } or { result }
 * They run before Claude Code acts (there is no "after"). `glass` is the app's handle on the glass.
 */
export type AppHookEvent = 'prompt.submit' | 'tool.call';
export type AppHookNext = (e: any) => Promise<any>;
export type AppHookHandler = (glass: AppHookGlass, e: any, next: AppHookNext) => any;
export type AppOn = (event: AppHookEvent, matcherOrHandler: Record<string, unknown> | AppHookHandler, handler?: AppHookHandler) => void;

export interface AppHookGlass {
  app: string; // the app's type
  stored: Record<string, unknown>; // its persistent values (defaults filled in)
  store(patch: Record<string, unknown>): void; // write some
  /** Ask the user in the glass (an Action card) and wait: the label they picked, or their own words. */
  ask(question: string, options?: (string | { label: string; description?: string })[]): Promise<string>;
}

/** What an app's command / onEvent gets beside its state. */
export interface AppContext {
  /** The app's persistent values, defaults filled in. */
  stored: Record<string, unknown>;
  /**
   * Return this to change state and write persistent values (declared keys only; undefined resets
   * one). Typed as the state; the reducer recognizes the write (a StoreWrite) and unwraps it.
   */
  store<S>(state: S, patch: Record<string, unknown>): S;
}

/** A core's answer that also writes persistent values (made by ctx.store). */
export class StoreWrite<S = unknown> {
  constructor(readonly state: S, readonly patch: Record<string, unknown>) {}
}

export const STORED_MAX_BYTES = 256 * 1024; // per app, per scope

const STORED_KEY = /^[a-zA-Z][a-zA-Z0-9]{0,31}$/;

/** Validate a manifest's stored block. */
export function parseStoredSpecs(raw: unknown): Record<string, StoredSpec> | undefined {
  if (raw == null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('stored must be an object');
  const out: Record<string, StoredSpec> = {};
  for (const [key, s] of Object.entries(raw as Record<string, any>)) {
    if (!STORED_KEY.test(key)) throw new Error(`stored: key "${key}" must be letters and digits`);
    const scope = s?.scope ?? 'session';
    if (scope !== 'session' && scope !== 'project' && scope !== 'global') throw new Error(`stored.${key}: scope must be session, project or global`);
    const def = s?.default ?? null;
    try { JSON.stringify(def); } catch { throw new Error(`stored.${key}: default must be JSON`); }
    out[key] = { scope, default: def };
  }
  return out;
}

/** An app's persistent values with defaults filled in. */
export function storedValues(app: Pick<AppDef, 'stored'>, saved: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(app.stored ?? {})) out[key] = saved && key in saved ? saved[key] : structuredClone(spec.default);
  return out;
}

export function str(args: Args, key: string, required = true): string {
  const v = args[key];
  if (v === undefined || v === null) {
    if (required) throw new Error(`missing --${key}`);
    return '';
  }
  return String(v);
}

export function unknownCommand(app: string, cmd: string): never {
  throw new Error(`${app}: unknown command "${cmd}"`);
}

/** Cap arrays so long sessions don't grow state.json without bound. */
export function capTail<T>(arr: T[], max: number): T[] {
  return arr.length > max ? arr.slice(arr.length - max) : arr;
}

export function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + `\n… (${s.length - max} more chars)` : s;
}

/**
 * Extra capabilities an app's view may ask for in its manifest. None by default: views are
 * sandboxed with no network, microphone or storage. Shown to the user in Settings.
 */
export interface AppPermissions {
  network: string[]; // origins the view may reach (fetch, WebSocket, scripts, images, frames), e.g. "http://127.0.0.1:3100"
  microphone: boolean;
  storage: boolean; // its own persistent localStorage/IndexedDB (origin glass-app://<type>)
  sharedSignIn: boolean; // its network origins' sign-in (localStorage + cookies) follows the user to every glass
  twoWay: boolean; // it may answer back into the Claude session (approvals, questions): the glass is otherwise one-way
}

export const NO_PERMISSIONS: AppPermissions = { network: [], microphone: false, storage: false, sharedSignIn: false, twoWay: false };

/** Validate a manifest's permissions: explicit http(s)/ws(s) origins only, no wildcards. */
export function parsePermissions(raw: unknown): AppPermissions {
  if (raw == null) return NO_PERMISSIONS;
  if (typeof raw !== 'object') throw new Error('permissions must be an object');
  const r = raw as Record<string, unknown>;
  const network = (Array.isArray(r.network) ? r.network : []).map((o) => {
    let u: URL;
    try { u = new URL(String(o)); } catch { throw new Error(`permissions.network: "${o}" is not a URL`); }
    if (!/^(https?|wss?):$/.test(u.protocol) || u.hostname.includes('*')) throw new Error(`permissions.network: "${o}" must be an http(s) or ws(s) origin`);
    return `${u.protocol}//${u.host}`;
  });
  return { network: [...new Set(network)], microphone: r.microphone === true, storage: r.storage === true, sharedSignIn: r.sharedSignIn === true && network.length > 0, twoWay: r.twoWay === true };
}

/**
 * One app setting, declared in the manifest's "settings": the user changes it in Settings → Apps or
 * with `claude-glass settings set app.<type>.<key> <value>`; the view gets the values as props, and
 * guide.md can depend on them (`<!-- when <key>=<value> -->`).
 */
export type SettingSpec =
  | { type: 'bool'; label: string; help?: string; default: boolean }
  | { type: 'enum'; label: string; help?: string; default: string; options: string[] }
  | { type: 'number'; label: string; help?: string; default: number; min?: number; max?: number }
  | { type: 'color'; label: string; help?: string; default: string }
  | { type: 'text'; label: string; help?: string; default: string };

const SETTING_KEY = /^[a-zA-Z][a-zA-Z0-9]{0,31}$/;

/** Validate a manifest's settings block. */
export function parseSettingSpecs(raw: unknown): Record<string, SettingSpec> | undefined {
  if (raw == null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('settings must be an object');
  const out: Record<string, SettingSpec> = {};
  for (const [key, s] of Object.entries(raw as Record<string, any>)) {
    if (!SETTING_KEY.test(key)) throw new Error(`settings: key "${key}" must be letters and digits`);
    if (!s || typeof s.label !== 'string') throw new Error(`settings.${key} needs a label`);
    const spec = { ...s, help: s.help === undefined ? undefined : String(s.help) } as SettingSpec;
    if (spec.type === 'enum' && (!Array.isArray(spec.options) || !spec.options.length)) throw new Error(`settings.${key}: enum needs options`);
    if (!['bool', 'enum', 'number', 'color', 'text'].includes(spec.type)) throw new Error(`settings.${key}: type must be bool, enum, number, color or text`);
    coerceSetting(spec, spec.default, key); // the default must be valid too
    out[key] = spec;
  }
  return out;
}

/** A value for one setting (strings from the CLI are converted); throws when it doesn't fit. */
export function coerceSetting(spec: SettingSpec, value: unknown, key = 'setting'): unknown {
  switch (spec.type) {
    case 'bool':
      if (value === true || value === 'true') return true;
      if (value === false || value === 'false') return false;
      throw new Error(`${key} must be true or false`);
    case 'enum':
      if (spec.options.includes(String(value))) return String(value);
      throw new Error(`${key} must be one of ${spec.options.join(', ')}`);
    case 'number': {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new Error(`${key} must be a number`);
      if ((spec.min != null && n < spec.min) || (spec.max != null && n > spec.max)) throw new Error(`${key} must be between ${spec.min ?? '-∞'} and ${spec.max ?? '∞'}`);
      return n;
    }
    case 'color': {
      const c = String(value).toLowerCase();
      if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/.test(c)) throw new Error(`${key} must be a hex color`);
      return c;
    }
    case 'text': return String(value ?? '').slice(0, 500);
  }
}

/** An app's settings with defaults filled in (stored values that no longer fit are ignored). */
export function settingValues(app: Pick<AppDef, 'settings'>, stored: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(app.settings ?? {})) {
    try { out[key] = stored && key in stored ? coerceSetting(spec, stored[key], key) : spec.default; } catch { out[key] = spec.default; }
  }
  return out;
}

/** What the renderer needs to know about an app. */
export interface AppInfo {
  type: string;
  title: string;
  icon: string;
  iconUrl?: string;
  singleton: boolean;
  frame: boolean; // view is a sandboxed frame (glass-app://<type>/view.html)
  viewCommands: string[];
  permissions: AppPermissions;
  settings?: Record<string, SettingSpec>;
  stored?: Record<string, StoredSpec>;
  description?: string; // shown in the Apps dialog
  builtin: boolean; // ships with the glass (a custom app that replaces one is not)
}

export function appInfo(app: AppDef): AppInfo {
  const viewCommands = new Set(app.viewCommands ?? []);
  for (const [k, c] of Object.entries(app.commands)) if (c.view) viewCommands.add(k);
  return { type: app.type, title: app.title, icon: app.icon, iconUrl: app.dir && app.iconFile ? `glass-app://${app.type}/${app.iconFile}` : undefined, singleton: app.singleton, frame: !!app.dir, viewCommands: [...viewCommands], permissions: app.permissions ?? NO_PERMISSIONS, settings: app.settings, stored: app.stored, description: app.description, builtin: app.source !== 'user' };
}
