// Custom apps ("mods"): folders dropped into ~/.claude/claude-glass/apps/<type>/.
//   glass-app.json  manifest (see ModManifest)
//   core.js         CommonJS, pure: { init(), command(state, cmd, args), onHook?(state, payload) }
//   view.html       the view, served into a sandboxed frame (optional: no view = blank window)
//   guide.md        instructions for Claude, appended to the glass guide (optional)
// Loaded once when the glass starts. A broken mod is skipped and reported; nothing else breaks.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { APPS, registerApp } from '../apps/registry';
import type { AppDef, CommandSpec } from '../apps/types';
import { appsDir } from './paths';

export const MOD_API_VERSION = 1;
const GUIDE_MAX = 1500;

export interface ModManifest {
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
}

export interface ModReport { type: string; dir: string; ok: boolean; error?: string; overrides?: boolean }

export function loadMods(dir: string = appsDir()): ModReport[] {
  if (!existsSync(dir)) return [];
  const reports: ModReport[] = [];
  for (const name of readdirSync(dir).sort()) {
    const modDir = join(dir, name);
    try { if (!statSync(modDir).isDirectory()) continue; } catch { continue; }
    try {
      const app = readMod(modDir);
      const overrides = APPS[app.type]?.source === 'builtin';
      registerApp(app);
      reports.push({ type: app.type, dir: modDir, ok: true, overrides });
    } catch (e: any) {
      reports.push({ type: name, dir: modDir, ok: false, error: e?.message ?? String(e) });
    }
  }
  return reports;
}

export function readMod(modDir: string): AppDef {
  const m = JSON.parse(readFileSync(join(modDir, 'glass-app.json'), 'utf8')) as ModManifest;
  if (m.apiVersion !== MOD_API_VERSION) throw new Error(`apiVersion must be ${MOD_API_VERSION}`);
  if (typeof m.type !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(m.type)) throw new Error('type must be lowercase letters, digits, dashes');
  if (typeof m.title !== 'string' || !m.title) throw new Error('title is required');
  const commands = m.commands ?? {};
  for (const [k, c] of Object.entries(commands)) {
    if (typeof c?.usage !== 'string' || typeof c?.help !== 'string') throw new Error(`command "${k}" needs usage and help`);
  }

  const corePath = join(modDir, 'core.js');
  delete require.cache[require.resolve(corePath)];
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require(corePath);
  const core = mod?.default ?? mod;
  if (typeof core?.init !== 'function' || typeof core?.command !== 'function') throw new Error('core.js must export init() and command()');
  if (core.onHook !== undefined && typeof core.onHook !== 'function') throw new Error('onHook must be a function');

  let guide: string | undefined;
  const guidePath = join(modDir, 'guide.md');
  if (existsSync(guidePath)) guide = readFileSync(guidePath, 'utf8').trim().slice(0, GUIDE_MAX);

  return {
    type: m.type,
    title: m.title,
    icon: typeof m.icon === 'string' && m.icon ? m.icon : '▢',
    singleton: m.singleton === true,
    description: String(m.description ?? ''),
    commands,
    internal: Array.isArray(m.internal) ? m.internal.map(String) : undefined,
    viewCommands: Array.isArray(m.viewCommands) ? m.viewCommands.map(String) : undefined,
    autoOpen: m.autoOpen === true,
    init: core.init,
    command: core.command,
    onHook: core.onHook,
    guide,
    source: 'user',
    dir: modDir,
  };
}
