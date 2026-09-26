import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isDefaultLayout } from './layout';
import { configPath } from './paths';
import type { GlobalConfig } from './types';

export const DEFAULT_CONFIG: GlobalConfig = {
  autoStart: false,
  background: 'aurora',
  defaultLayout: 'grid',
  windowOpacity: 0.78,
  dockAutoHide: false,
  dockOrder: 'windows',
  waitingGlow: true,
  animateBackground: true,
  scope: 'session',
  wheelDesktops: true,
  disabledApps: [],
};

export function loadConfig(): GlobalConfig {
  try {
    const raw = JSON.parse(readFileSync(configPath(), 'utf8'));
    const c = { ...DEFAULT_CONFIG, ...raw };
    if (!isDefaultLayout(c.defaultLayout)) c.defaultLayout = DEFAULT_CONFIG.defaultLayout;
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
    case 'wheelDesktops': return value === true || value === 'true';
    case 'disabledApps': {
      const list = Array.isArray(value) ? value : String(value ?? '').split(',');
      return [...new Set(list.map((v) => String(v).trim()).filter((v) => v && v !== 'settings'))];
    }
    case 'scope': if (value !== 'session' && value !== 'folder') throw new Error(`scope must be session or folder`); return value;
    case 'dockOrder': if (value !== 'windows' && value !== 'fixed') throw new Error(`dockOrder must be windows or fixed`); return value;
    case 'windowOpacity': return Math.max(0.2, Math.min(1, Number(value)));
    case 'defaultLayout': if (!isDefaultLayout(value)) throw new Error(`unknown layout ${value}`); return value;
    case 'background': return String(value);
    default: throw new Error(`unknown global setting "${key}"`);
  }
}
