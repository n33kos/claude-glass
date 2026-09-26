// The shared app contract (strategy pattern). Every app implements AppDef; the window
// manager and CLI treat all apps identically. Core side only: no React, no DOM.

export type Args = Record<string, unknown>;

export interface CommandSpec {
  usage: string; // e.g. "set --text <markdown> | --file <path>"
  help: string;
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
