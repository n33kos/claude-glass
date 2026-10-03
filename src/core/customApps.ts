// Custom apps: folders dropped into ~/.claude/claude-glass/apps/<type>/ (built-in apps use the
// same format, compiled into dist/apps/<type>).
//   glass-app.json  manifest (see AppManifest)
//   core.js         CommonJS, pure: { init(), command(state, cmd, args), onEvent?(state, event) }
//   view.html       the view, served into a sandboxed frame (optional: no view = blank window)
//   guide.md        instructions for Claude, appended to the glass guide (optional)
// Loaded once when the glass starts. A broken app is skipped and reported; nothing else breaks.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { APPS, registerApp } from '../apps/registry';
import { parsePermissions, parseSettingSpecs, parseStoredSpecs, type AppDef, type CommandSpec } from '../apps/types';
import { appsDir } from './paths';

export const APP_API_VERSION = 1;
const GUIDE_MAX = 1500;

export interface AppManifest {
  apiVersion: number;
  type: string;
  title: string;
  icon?: string;
  singleton?: boolean;
  description?: string;
  commands?: Record<string, CommandSpec>;
  internal?: string[];
  viewCommands?: string[];
  autoOpen?: boolean;
  display?: 'window' | 'overlay'; // overlay: covers the whole glass, click-through
  chrome?: 'window' | 'none'; // none: no glass panel or title bar; the view draws its own look
  permissions?: { network?: string[]; microphone?: boolean; storage?: boolean; sharedSignIn?: boolean; twoWay?: boolean; reads?: string[] };
  settings?: Record<string, unknown>;
  stored?: Record<string, unknown>; // persistent values: { key: { scope, default } }
}

export interface AppReport { type: string; dir: string; ok: boolean; error?: string; overrides?: boolean }

export function loadApps(dir: string = appsDir()): AppReport[] {
  if (!existsSync(dir)) return [];
  const reports: AppReport[] = [];
  for (const name of readdirSync(dir).sort()) {
    const appDir = join(dir, name);
    try { if (!statSync(appDir).isDirectory()) continue; } catch { continue; }
    try {
      const app = readApp(appDir);
      const overrides = APPS[app.type]?.source === 'builtin';
      registerApp(app);
      reports.push({ type: app.type, dir: appDir, ok: true, overrides });
    } catch (e: any) {
      reports.push({ type: name, dir: appDir, ok: false, error: e?.message ?? String(e) });
    }
  }
  return reports;
}

export function readApp(appDir: string): AppDef {
  const m = JSON.parse(readFileSync(join(appDir, 'glass-app.json'), 'utf8')) as AppManifest;
  if (m.apiVersion !== APP_API_VERSION) throw new Error(`apiVersion must be ${APP_API_VERSION}`);
  if (typeof m.type !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(m.type)) throw new Error('type must be lowercase letters, digits, dashes');
  if (typeof m.title !== 'string' || !m.title) throw new Error('title is required');
  const commands = m.commands ?? {};
  for (const [k, c] of Object.entries(commands)) {
    if (typeof c?.usage !== 'string' || typeof c?.help !== 'string') throw new Error(`command "${k}" needs usage and help`);
  }

  const permissions = parsePermissions(m.permissions);
  const settings = parseSettingSpecs(m.settings);
  const stored = parseStoredSpecs(m.stored);

  const corePath = join(appDir, 'core.js');
  delete require.cache[require.resolve(corePath)];
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const loaded = require(corePath);
  const core = loaded?.default ?? loaded;
  if (typeof core?.init !== 'function' || typeof core?.command !== 'function') throw new Error('core.js must export init() and command()');
  if (core.onHook !== undefined) throw new Error('onHook was replaced by onEvent(state, event): see docs/apps.md');
  if (core.onEvent !== undefined && typeof core.onEvent !== 'function') throw new Error('onEvent must be a function');
  if (core.register !== undefined && typeof core.register !== 'function') throw new Error('register must be a function');
  if (core.share !== undefined && typeof core.share !== 'function') throw new Error('share must be a function');
  if (core.register && !permissions.twoWay) throw new Error('register(on) answers back into the Claude session: it needs "permissions": { "twoWay": true }');

  // Icon: an image file (named in the manifest, or icon.svg/icon.png in the folder), else a glyph.
  const IMG = /\.(svg|png|jpe?g|webp)$/i;
  const named = typeof m.icon === 'string' && IMG.test(m.icon) && !m.icon.includes('..') ? m.icon.replace(/^\.?\//, '') : undefined;
  const iconFile = [named, 'icon.svg', 'icon.png'].find((f) => f && existsSync(join(appDir, f)));

  let guide: string | undefined;
  const guidePath = join(appDir, 'guide.md');
  if (existsSync(guidePath)) guide = readFileSync(guidePath, 'utf8').trim().slice(0, GUIDE_MAX);

  return {
    type: m.type,
    title: m.title,
    icon: typeof m.icon === 'string' && m.icon && !IMG.test(m.icon) ? m.icon : '▢',
    iconFile,
    singleton: m.singleton === true,
    description: String(m.description ?? ''),
    commands,
    internal: Array.isArray(m.internal) ? m.internal.map(String) : undefined,
    viewCommands: Array.isArray(m.viewCommands) ? m.viewCommands.map(String) : undefined,
    autoOpen: m.autoOpen === true,
    display: m.display === 'overlay' ? 'overlay' : undefined,
    chrome: m.chrome === 'none' ? 'none' : undefined,
    init: core.init,
    command: core.command,
    onEvent: core.onEvent,
    register: core.register,
    share: core.share,
    guide,
    settings,
    stored,
    permissions,
    source: 'user',
    dir: appDir,
  };
}

/**
 * Built-in apps whose views ship in the app format (dist/apps/<type>/view.html) get their folder
 * attached so the shell frames them like any app. Call before loadApps so the user's apps still win.
 */
export function attachBuiltinViews(dir: string): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const app = APPS[name];
    if (app?.source !== 'builtin' || !existsSync(join(dir, name, 'view.html'))) continue;
    const guidePath = join(dir, name, 'guide.md');
    const guide = existsSync(guidePath) ? readFileSync(guidePath, 'utf8').trim().slice(0, GUIDE_MAX) : app.guide;
    registerApp({ ...app, dir: join(dir, name), guide });
  }
}
