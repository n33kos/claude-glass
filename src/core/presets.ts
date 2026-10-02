// Presets: a saved frame for a glass. Which windows sit in which docks, edges and corners (and their
// sizes, splits, keep-open; the JSON key is still "sidebars"), desktop layouts, the glass's own
// settings, and look/view settings. One JSON
// file each in ~/.claude/claude-glass/presets/, so they're easy to read, edit and share.
// Applying one is plain reducer actions (plus global settings), the same ones a user's drags make.
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from './config';
import { DOCKS, isCorner } from './layout';
import { glassHome } from './paths';
import type { Action, Dock, GlassState, GlobalConfig, LayoutName, SessionSettings } from './types';

export interface PresetWindow { id: string; type: string; title?: string }
export interface Preset {
  name: string;
  description: string; // what it's for: shown in Settings, and to Claude when choosing one
  sidebars?: Partial<Record<Dock, { windows: PresetWindow[]; size?: number; height?: number; open?: boolean; float?: boolean; split?: number[] }>>;
  desktops?: LayoutName[];
  session?: Partial<SessionSettings>; // this glass's settings (history mode, auto-open...)
  look?: Partial<GlobalConfig>; // view settings, which apply to every glass
}

/** Global settings a preset carries: how things look and behave on screen, nothing else. */
export const LOOK_KEYS = ['nestedView', 'nestedStyle', 'defaultLayout', 'windowOpacity', 'background', 'backgroundColors', 'animateBackground',
  'stateColors', 'waitingGlow', 'theme', 'signals', 'signalStrength', 'signalDone', 'followEdits', 'followPlans', 'followTests', 'followWeb', 'followImages', 'followAgents', 'turnProgress', 'contextGauge', 'interruptButton', 'askBox', 'viewContext', 'launcherAutoHide', 'launcherOrder', 'launcherGroup', 'dockOpen', 'selectToInteract', 'wheelDesktops'] as const satisfies readonly (keyof GlobalConfig)[];

export const presetsDir = () => join(glassHome(), 'presets');
const NAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,39}$/;
const fileFor = (name: string) => {
  if (!NAME.test(name)) throw new Error('preset names are letters, digits, spaces, dots, dashes (up to 40)');
  return join(presetsDir(), `${name}.json`);
};

export function listPresets(): Preset[] {
  if (!existsSync(presetsDir())) return [];
  return readdirSync(presetsDir()).filter((f) => f.endsWith('.json')).flatMap((f) => {
    try { const p = JSON.parse(readFileSync(join(presetsDir(), f), 'utf8')) as Preset; return [{ ...p, name: f.slice(0, -5) }]; } catch { return []; }
  }).sort((a, b) => a.name.localeCompare(b.name));
}

export function loadPreset(name: string): Preset {
  const f = fileFor(name);
  if (!existsSync(f)) throw new Error(`no preset "${name}"${listPresets().length ? ` (presets: ${listPresets().map((p) => p.name).join(', ')})` : ''}`);
  return { ...(JSON.parse(readFileSync(f, 'utf8')) as Preset), name };
}

export function savePreset(p: Preset): Preset {
  const f = fileFor(p.name);
  mkdirSync(presetsDir(), { recursive: true });
  writeJsonAtomic(f, p);
  return p;
}

export function deletePreset(name: string): void {
  const f = fileFor(name);
  if (existsSync(f)) unlinkSync(f);
}

/** The current glass as a preset. */
export function capturePreset(s: GlassState, config: GlobalConfig, name: string, description = ''): Preset {
  const sidebars: Preset['sidebars'] = {};
  for (const e of DOCKS) {
    const ids = (s.tucked?.[e] ?? []).filter((id) => s.instances[id]);
    if (!ids.length) continue;
    const height = isCorner(e) ? s.tuckHeight?.[e] : undefined;
    sidebars[e] = {
      windows: ids.map((id) => ({ id, type: s.instances[id].type, title: s.instances[id].title })),
      open: !!s.tuckKeep?.includes(e),
      ...(s.tuckFloat?.includes(e) ? { float: true } : {}),
      ...(s.tuckSize?.[e] ? { size: s.tuckSize[e] } : {}),
      ...(height ? { height } : {}),
      ...(s.tuckSplit?.[e]?.length === ids.length ? { split: s.tuckSplit[e] } : {}),
    };
  }
  const { backgroundColors: _signal, ...session } = s.settings; // Claude's one-off tint isn't part of a frame
  const look = Object.fromEntries(LOOK_KEYS.map((k) => [k, config[k]])) as Partial<GlobalConfig>;
  return { name, description, sidebars, desktops: s.desktops, session, look };
}

/**
 * The reducer actions that put a preset's frame on a glass: its sidebar windows (created if the
 * glass doesn't have them), pinned in order, sized, split and kept open; windows pinned elsewhere
 * go back to the layout; desktop layouts; session settings. Windows of apps that aren't installed
 * are skipped and named in `skipped`.
 */
export function presetActions(s: GlassState, p: Preset, installed: (type: string) => boolean): { actions: Action[]; skipped: string[] } {
  const actions: Action[] = [];
  const skipped: string[] = [];
  const keep = new Set(Object.values(p.sidebars ?? {}).flatMap((sb) => sb?.windows.map((w) => w.id) ?? []));
  for (const e of DOCKS) for (const id of s.tucked?.[e] ?? []) if (!keep.has(id)) actions.push({ type: 'window.untuck', id });
  for (const e of DOCKS) {
    const sb = p.sidebars?.[e];
    if (!sb?.windows.length) { if (s.tuckKeep?.includes(e)) actions.push({ type: 'tuck.keep', edge: e, keep: false }); continue; }
    const ws = sb.windows.filter((w) => (installed(w.type) ? true : (skipped.push(`${w.id} (${w.type})`), false)));
    ws.forEach((w, i) => {
      if (!s.instances[w.id]) actions.push({ type: 'instance.create', appType: w.type, id: w.id, title: w.title, open: false });
      actions.push({ type: 'window.tuck', id: w.id, edge: e, index: i });
    });
    if (!ws.length) continue;
    if (sb.size || (sb.height && isCorner(e))) actions.push({ type: 'tuck.size', edge: e, size: sb.size || undefined, height: isCorner(e) ? sb.height || undefined : undefined });
    if (sb.split?.length === ws.length && ws.length > 1) actions.push({ type: 'tuck.split', edge: e, shares: sb.split });
    actions.push({ type: 'tuck.keep', edge: e, keep: sb.open !== false });
    if (sb.open !== false) actions.push({ type: 'tuck.float', edge: e, float: sb.float === true });
  }
  p.desktops?.forEach((layout, desktop) => actions.push({ type: 'desktop.layout', desktop, layout }));
  for (const [key, value] of Object.entries(p.session ?? {})) actions.push({ type: 'settings.set', key, value });
  return { actions, skipped };
}
