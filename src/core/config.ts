import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_PALETTES, parseColors, parsePalettes } from './colors';
import { isDefaultLayout } from './layout';
import { configPath } from './paths';
import { FOLLOW_MODES, type FollowMode, type GlobalConfig } from './types';

export const DEFAULT_CONFIG: GlobalConfig = {
  autoStart: false,
  background: 'graphite',
  backgroundColors: [],
  stateColors: false, // the signal layer says the same things, more precisely
  theme: 'dark',
  signals: true,
  signalStrength: 'normal',
  signalDone: true,
  followEdits: 'off',
  followPlans: 'off',
  followTests: 'light',
  followWeb: 'off',
  followImages: 'off',
  followAgents: 'off',
  turnProgress: true,
  contextGauge: true,
  interruptButton: false,
  askBox: false,
  viewContext: false,
  statePalettes: DEFAULT_PALETTES,
  defaultLayout: 'grid',
  windowOpacity: 0.78,
  launcherAutoHide: false,
  launcherOrder: 'windows',
  launcherGroup: true,
  dockOpen: 'click',
  waitingGlow: true,
  animateBackground: true,
  scope: 'session',
  wheelDesktops: true,
  disabledApps: [],
  nestedView: false,
  nestedStyle: 'spiral',
  toolReminders: true,
  selectToInteract: true,
  defaultPreset: '',
  appSettings: {},
};

/** Settings that were renamed: "dock" now means the docks at the edges and corners; the bottom bar is the launcher. */
export const RENAMED_SETTINGS: Record<string, keyof GlobalConfig> = { dockAutoHide: 'launcherAutoHide', dockOrder: 'launcherOrder' };
export const settingKey = (key: string): string => RENAMED_SETTINGS[key] ?? key;

export function loadConfig(): GlobalConfig {
  try {
    const raw = JSON.parse(readFileSync(configPath(), 'utf8'));
    for (const [old, key] of Object.entries(RENAMED_SETTINGS)) {
      if (old in raw && !(key in raw)) raw[key] = raw[old];
      delete raw[old];
    }
    const c = { ...DEFAULT_CONFIG, ...raw };
    if (!isDefaultLayout(c.defaultLayout)) c.defaultLayout = DEFAULT_CONFIG.defaultLayout;
    try { c.backgroundColors = parseColors(c.backgroundColors ?? []); } catch { c.backgroundColors = []; }
    try { c.statePalettes = parsePalettes(c.statePalettes); } catch { c.statePalettes = DEFAULT_PALETTES; }
    if (c.nestedStyle === 'watch') c.nestedStyle = 'carousel'; // its first name
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
    case 'launcherAutoHide':
    case 'launcherGroup':
    case 'waitingGlow':
    case 'animateBackground':
    case 'wheelDesktops':
    case 'nestedView':
    case 'stateColors':
    case 'selectToInteract':
    case 'signals':
    case 'signalDone':
    case 'turnProgress':
    case 'contextGauge':
    case 'interruptButton':
    case 'askBox':
    case 'viewContext':
    case 'toolReminders': return value === true || value === 'true';
    case 'followEdits':
    case 'followPlans':
    case 'followTests':
    case 'followWeb':
    case 'followImages':
    case 'followAgents':
      if (!FOLLOW_MODES.includes(value as FollowMode)) throw new Error(`${key} must be ${FOLLOW_MODES.join(', ')}`);
      return value;
    case 'signalStrength': if (value !== 'subtle' && value !== 'normal' && value !== 'strong') throw new Error('signalStrength must be subtle, normal or strong'); return value;
    case 'theme': if (value !== 'dark' && value !== 'light' && value !== 'system') throw new Error('theme must be dark, light or system'); return value;
    case 'statePalettes': return parsePalettes(value);
    case 'disabledApps': {
      const list = Array.isArray(value) ? value : String(value ?? '').split(',');
      return [...new Set(list.map((v) => String(v).trim()).filter((v) => v && v !== 'settings'))];
    }
    case 'scope': if (value !== 'session' && value !== 'folder') throw new Error(`scope must be session or folder`); return value;
    case 'nestedStyle':
      if (value === 'watch') return 'carousel'; // its first name
      if (value !== 'spiral' && value !== 'carousel') throw new Error('nestedStyle must be spiral or carousel');
      return value;
    case 'launcherOrder': if (value !== 'windows' && value !== 'fixed') throw new Error(`launcherOrder must be windows or fixed`); return value;
    case 'dockOpen': if (value !== 'click' && value !== 'hover') throw new Error(`dockOpen must be click or hover`); return value;
    case 'windowOpacity': return Math.max(0.2, Math.min(1, Number(value)));
    case 'defaultLayout': if (!isDefaultLayout(value)) throw new Error(`unknown layout ${value}`); return value;
    case 'background': return String(value);
    case 'defaultPreset': return value === 'none' || value == null ? '' : String(value);
    case 'backgroundColors': return parseColors(value);
    default: throw new Error(`unknown global setting "${key}"`);
  }
}

/** What each global setting does, for `claude-glass settings` (Claude reads this). */
export const SETTINGS_HELP: Record<keyof GlobalConfig, string> = {
  nestedView: 'true|false: one screen, the focused window largest, the others smaller around it',
  nestedStyle: 'spiral|carousel: nested view arrangement (carousel: focused window centered, neighbors as small tiles either side)',
  defaultLayout: 'claude|full|split|main-left|main-left-nest|columns|grid: layout for new desktops',
  windowOpacity: '0.2..1: window glass opacity',
  background: 'aurora|dune|tide|graphite or an absolute image path',
  stateColors: 'true|false: the wallpaper light follows the session (working, waiting on you, done, ended)',
  statePalettes: 'JSON {"waiting":["#e0a030"],...}: colors per state (working|waiting|idle|ended); [] = own colors',
  backgroundColors: 'up to 4 hex colors ("#2b6f8f,#7a3d8c"): the user\'s own wallpaper light; empty = the preset\'s (change only if asked)',
  animateBackground: 'true|false: drift the wallpaper light',
  waitingGlow: 'true|false: amber edge glow while Claude waits on the user',
  theme: 'dark|light|system: the glass\'s theme (system follows macOS)',
  signals: 'true|false: the signal layer (the wallpaper light points at windows and reports done, failed, progress)',
  signalStrength: 'subtle|normal|strong: how bright signals get',
  signalDone: 'true|false: a green bloom when a long turn is done',
  followEdits: 'off|light|front|both|focus: when an edit lands, light its diff, bring it to the front, both, or both and show desktop 1 (change only if asked)',
  followPlans: 'off|light|front|both|focus: the same when a plan is written',
  followTests: 'off|light|front|both|focus: the same when a test run fails (lit red)',
  followWeb: 'off|light|front|both|focus: the same for a web search or page',
  followImages: 'off|light|front|both|focus: the same when Claude reads an image',
  followAgents: 'off|light|front|both|focus: the same when a subagent starts',
  turnProgress: 'true|false: a thin white bar along the bottom while Claude works on a turn',
  contextGauge: 'true|false: how full Claude\'s context window is, in the top bar (hover: tokens, cost, plan limits)',
  interruptButton: 'true|false: two-way: while Claude works, clicking the status pill ends the turn (change only if asked)',
  askBox: 'true|false: two-way: an "Ask Claude" field in the header (Conversation always has its own message box); what the user types is sent as their prompt (change only if asked)',
  viewContext: 'true|false: each prompt carries what\'s on the glass now (like claude-glass view), so Claude needn\'t run view; costs tokens (change only if asked)',
  launcherAutoHide: 'true|false: hide the launcher (the bottom bar) until the pointer reaches the bottom edge',
  launcherOrder: 'windows|fixed: launcher follows window order, or a fixed order by app',
  launcherGroup: 'true|false: an app\'s windows share one launcher icon, with a menu to pick one',
  dockOpen: 'click|hover: a hidden dock (edge or corner) slides out when its tab is clicked, or on hover',
  wheelDesktops: 'true|false: vertical scroll outside windows switches desktops',
  disabledApps: 'comma-separated app types the user turned off (change only if asked)',
  autoStart: 'true|false: open a glass when a Claude session starts',
  scope: 'session|folder: one glass per session, or one per project folder',
  defaultPreset: 'a preset name (or none): the frame every new glass starts with (claude-glass preset)',
  selectToInteract: 'true|false: click a window to use it (scroll over the others walks desktops); false = every window live',
  appSettings: 'apps\' own settings: set one with app.<type>.<key> <value> (listed below)',
  toolReminders: 'true|false: remind Claude to use Read/Edit/Write when a Bash command reads or writes files (change only if asked)',
};
