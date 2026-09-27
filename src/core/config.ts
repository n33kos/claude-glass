import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseColors } from './colors';
import { isDefaultLayout } from './layout';
import { configPath } from './paths';
import type { GlobalConfig } from './types';

export const DEFAULT_CONFIG: GlobalConfig = {
  autoStart: false,
  background: 'aurora',
  backgroundColors: [],
  defaultLayout: 'grid',
  windowOpacity: 0.78,
  dockAutoHide: false,
  dockOrder: 'windows',
  waitingGlow: true,
  animateBackground: true,
  scope: 'session',
  wheelDesktops: true,
  disabledApps: [],
  nestedView: false,
  toolReminders: true,
};

export function loadConfig(): GlobalConfig {
  try {
    const raw = JSON.parse(readFileSync(configPath(), 'utf8'));
    const c = { ...DEFAULT_CONFIG, ...raw };
    if (!isDefaultLayout(c.defaultLayout)) c.defaultLayout = DEFAULT_CONFIG.defaultLayout;
    try { c.backgroundColors = parseColors(c.backgroundColors ?? []); } catch { c.backgroundColors = []; }
    return c;
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(c: GlobalConfig): void {
  writeJsonAtomic(configPath(), c);
}

export function writeJsonAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

export function coerceConfigValue(key: keyof GlobalConfig, value: unknown): unknown {
  switch (key) {
    case 'autoStart':
    case 'dockAutoHide':
    case 'waitingGlow':
    case 'animateBackground':
    case 'wheelDesktops':
    case 'nestedView':
    case 'toolReminders': return value === true || value === 'true';
    case 'disabledApps': {
      const list = Array.isArray(value) ? value : String(value ?? '').split(',');
      return [...new Set(list.map((v) => String(v).trim()).filter((v) => v && v !== 'settings'))];
    }
    case 'scope': if (value !== 'session' && value !== 'folder') throw new Error(`scope must be session or folder`); return value;
    case 'dockOrder': if (value !== 'windows' && value !== 'fixed') throw new Error(`dockOrder must be windows or fixed`); return value;
    case 'windowOpacity': return Math.max(0.2, Math.min(1, Number(value)));
    case 'defaultLayout': if (!isDefaultLayout(value)) throw new Error(`unknown layout ${value}`); return value;
    case 'background': return String(value);
    case 'backgroundColors': return parseColors(value);
    default: throw new Error(`unknown global setting "${key}"`);
  }
}

/** What each global setting does, for `claude-glass settings` (Claude reads this). */
export const SETTINGS_HELP: Record<keyof GlobalConfig, string> = {
  nestedView: 'true|false: one screen, newest window big, older ones spiral smaller',
  defaultLayout: 'claude|full|split|main-left|main-left-nest|columns|grid: layout for new desktops',
  windowOpacity: '0.2..1: window glass opacity',
  background: 'aurora|dune|tide|graphite or an absolute image path',
  backgroundColors: 'up to 4 hex colors ("#2b6f8f,#7a3d8c"): the user\'s own wallpaper light; empty = the preset\'s (change only if asked)',
  animateBackground: 'true|false: drift the wallpaper light',
  waitingGlow: 'true|false: amber edge glow while Claude waits on the user',
  dockAutoHide: 'true|false: hide the dock until the pointer reaches the bottom edge',
  dockOrder: 'windows|fixed: dock follows window order, or a fixed order by app',
  wheelDesktops: 'true|false: vertical scroll outside windows switches desktops',
  disabledApps: 'comma-separated app types the user turned off (change only if asked)',
  autoStart: 'true|false: open a glass when a Claude session starts',
  scope: 'session|folder: one glass per session, or one per project folder',
  toolReminders: 'true|false: remind Claude to use Read/Edit/Write when a Bash command reads or writes files (change only if asked)',
};
