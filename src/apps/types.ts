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
  icon: string; // single glyph for dock/title bar
  singleton: boolean; // singleton apps use their type as instance id
  description: string;
  commands: Record<string, CommandSpec>;
  init(): S;
  /** Apply a command. Must be pure: return new state, throw Error on bad input. */
  command(state: S, command: string, args: Args): S;
  /** Optional: see every Claude Code hook payload and update state (pure). Singletons are created on first change. */
  onHook?(state: S, payload: any): S;
  autoOpen?: boolean; // open the window the first time onHook creates the instance
  internal?: string[]; // commands only hooks/the view use; hidden from Claude's catalog
  viewCommands?: string[]; // commands the app's view may run (plus any CommandSpec with view: true)
  guide?: string; // instructions for Claude, appended to the glass guide
  permissions?: AppPermissions;
  source?: 'builtin' | 'user';
  dir?: string; // mod folder: its view.html is served into a sandboxed frame
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
}

export const NO_PERMISSIONS: AppPermissions = { network: [], microphone: false, storage: false };

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
  return { network: [...new Set(network)], microphone: r.microphone === true, storage: r.storage === true };
}

/** What the renderer needs to know about an app. */
export interface AppInfo {
  type: string;
  title: string;
  icon: string;
  singleton: boolean;
  frame: boolean; // view is a mod-style frame (glass-app://<type>/view.html)
  viewCommands: string[];
  permissions: AppPermissions;
}

export function appInfo(app: AppDef): AppInfo {
  const viewCommands = new Set(app.viewCommands ?? []);
  for (const [k, c] of Object.entries(app.commands)) if (c.view) viewCommands.add(k);
  return { type: app.type, title: app.title, icon: app.icon, singleton: app.singleton, frame: !!app.dir, viewCommands: [...viewCommands], permissions: app.permissions ?? NO_PERMISSIONS };
}
