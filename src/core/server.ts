// GlassCore: owns one session's state, persistence, and the Unix socket. Plain Node — Electron
// main wraps it, integration tests run it directly.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import net from 'node:net';
import { basename, dirname } from 'node:path';
import { APPS, isInternal } from '../apps/registry';
import { coerceSetting, settingValues } from '../apps/types';
import { coerceConfigValue, loadConfig, saveConfig, writeJsonAtomic } from './config';
import { guideFor } from './guide';
import { capturePreset, deletePreset, listPresets, loadPreset, LOOK_KEYS, presetActions, savePreset, type Preset } from './presets';
import { applyHook } from './hooks';
import { loadMods, type ModReport } from './mods';
import { computeDesktops, desktopsFor, edgeSize, effectiveLayout, EDGES, LAYOUTS, nestedSlots } from './layout';
import { filesDir, sessionDir, socketPath, statePath } from './paths';
import { initialState, reduce } from './reducer';
import type { Action, GlassState, Envelope, GlobalConfig, Reply } from './types';

export type Listener = (state: GlassState, config: GlobalConfig) => void;

export class GlassCore {
  state: GlassState;
  config: GlobalConfig;
  private listeners = new Set<Listener>();
  private saveTimer: NodeJS.Timeout | null = null;
  private server: net.Server | null = null;
  onQuit: () => void = () => {};
  mods: ModReport[] = [];

  constructor(readonly sessionId: string, cwd: string) {
    mkdirSync(sessionDir(sessionId), { recursive: true });
    this.config = loadConfig();
    this.mods = loadMods();
    const saved = loadState(sessionId);
    this.state = saved ?? initialState({ id: sessionId, cwd });
    if (cwd && !this.state.session.cwd) this.state = reduce(this.state, { type: 'session.update', patch: { cwd } }).state;
    // Reopened glass: fresh start time is not interesting, but "ended" must be cleared.
    this.state = reduce(this.state, { type: 'session.update', patch: { endedAt: undefined, activity: 'idle' } }).state;
    // A brand-new glass starts from the default preset, if the user picked one.
    if (!saved && this.config.defaultPreset) {
      try { this.applyPreset(loadPreset(this.config.defaultPreset)); } catch {}
    }
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private commit(next: GlassState) {
    if (next === this.state) return;
    this.state = next;
    this.scheduleSave();
    for (const fn of this.listeners) fn(this.state, this.config);
  }

  private assertEnabled(action: Action) {
    const disabled = this.config.disabledApps ?? [];
    if (!disabled.length) return;
    const type = action.type === 'instance.create' ? action.appType
      : action.type === 'app.command' || action.type === 'window.open' ? this.state.instances[action.id]?.type
      : undefined;
    if (type && disabled.includes(type)) throw new Error(`the "${type}" app is turned off by the user (in Settings). Don't use it.`);
  }

  dispatch(action: Action): unknown {
    // History mode: each page has its own browser window; a highlight goes to the newest page.
    if (action.type === 'app.command' && action.id === 'browser' && action.command === 'highlight' && this.state.settings.windowMode === 'history') {
      const pages = Object.values(this.state.instances)
        .filter((i) => i.type === 'browser' && (this.state.appState[i.id] as { history?: { kind: string }[] })?.history?.some((h) => h.kind === 'page'))
        .sort((a, b) => b.createdAt - a.createdAt);
      if (pages[0]) action = { ...action, id: pages[0].id };
    }
    this.assertEnabled(action);
    if (action.type === 'window.move' && this.state.settings.windowMode === 'history') {
      throw new Error('the user has history mode on: windows stay in time order (newest first), so they can\'t be moved.');
    }
    if (action.type === 'desktop.layout' && this.config.nestedView) {
      throw new Error('the user has the nested view on (newest window big, older ones smaller); layouts don\'t apply. Use window move <id> 0 to put something in the big pane.');
    }
    const { state, result } = reduce(this.state, action);
    this.commit(state);
    return result ?? null;
  }

  hook(payload: unknown): void {
    this.commit(applyHook(this.state, payload, {
      ingestFile: (p) => this.ingestFile(p),
      disabled: new Set(this.config.disabledApps ?? []),
      windowMode: this.state.settings.windowMode,
      readText: (p) => { try { return statSync(p).size < 1_000_000 ? readFileSync(p, 'utf8') : null; } catch { return null; } },
    }));
  }

  /**
   * Delete copies in files/ that no window refers to anymore (images of deleted windows, ones
   * that fell off a viewer's history). Files under 10 minutes old are kept: the CLI copies a file in
   * before it tells the glass about it.
   */
  pruneFiles(): number {
    const dir = filesDir(this.sessionId);
    if (!existsSync(dir)) return 0;
    const referenced = JSON.stringify(this.state.appState);
    const cutoff = Date.now() - 10 * 60 * 1000;
    let removed = 0;
    for (const name of readdirSync(dir)) {
      if (name === '.thumbs' || referenced.includes(name)) continue;
      const p = `${dir}/${name}`;
      try { if (statSync(p).mtimeMs < cutoff) { unlinkSync(p); removed++; } } catch {}
    }
    // Thumbnails (<source>@<width>.jpg) go with their source.
    const thumbs = `${dir}/.thumbs`;
    if (existsSync(thumbs)) for (const name of readdirSync(thumbs)) {
      if (!existsSync(`${dir}/${name.replace(/@\d+\.jpg$/, '')}`)) try { unlinkSync(`${thumbs}/${name}`); } catch {}
    }
    return removed;
  }
  private lastPrune = 0;

  ingestFile(path: string): string | null {
    try {
      if (!existsSync(path) || statSync(path).size > 25_000_000) return null;
      const dir = filesDir(this.sessionId);
      mkdirSync(dir, { recursive: true });
      const dest = `${dir}/${Date.now()}-${basename(path).replace(/[^\w.-]/g, '_')}`;
      copyFileSync(path, dest);
      return dest;
    } catch {
      return null;
    }
  }

  setConfig(key: string, value: unknown): GlobalConfig {
    // app.<type>.<key>: one of an app's own settings, validated against its manifest.
    const appKey = key.match(/^app\.([a-z][a-z0-9-]*)\.([A-Za-z0-9]+)$/);
    if (appKey) {
      const [, type, name] = appKey;
      const spec = APPS[type]?.settings?.[name];
      if (!spec) throw new Error(`no setting "${name}" for app "${type}"${APPS[type]?.settings ? ` (settings: ${Object.keys(APPS[type].settings!).join(', ')})` : ''}`);
      const all = this.config.appSettings ?? {};
      this.config = { ...this.config, appSettings: { ...all, [type]: { ...all[type], [name]: coerceSetting(spec, value, name) } } };
      saveConfig(this.config);
      for (const fn of this.listeners) fn(this.state, this.config);
      return this.config;
    }
    const v = coerceConfigValue(key as keyof GlobalConfig, value);
    this.config = { ...this.config, [key]: v };
    saveConfig(this.config);
    if (key === 'disabledApps') {
      // Close the windows of apps that were just turned off.
      const off = new Set(this.config.disabledApps);
      let s = this.state;
      for (const id of s.order) if (off.has(s.instances[id]?.type)) s = reduce(s, { type: 'window.close', id }).state;
      this.commit(s);
    }
    for (const fn of this.listeners) fn(this.state, this.config);
    return this.config;
  }

  view() {
    const s = this.state;
    const pages = computeDesktops(s.order, desktopsFor(s.desktops, this.config.nestedView), this.config.defaultLayout);
    const meta = (id: string) => ({ id, type: s.instances[id].type, title: s.instances[id].title });
    return {
      session: { id: s.session.id, title: s.session.title, cwd: s.session.cwd, activity: s.session.activity, ended: !!s.session.endedAt },
      userViewingDesktop: s.ui.viewingDesktop,
      // How the user displays things, so Claude can judge layout changes.
      display: { nestedView: this.config.nestedView, windowMode: s.settings.windowMode ?? 'live' },
      // rect: where a window sits in the tiling area (fractions 0..1; nested view shown unscrolled).
      desktops: pages.map((p) => {
        const slots = p.layout === 'nested' ? nestedSlots(p.windows.length) : LAYOUTS[effectiveLayout(p)].slots;
        return {
          desktop: p.index, layout: p.layout,
          windows: p.windows.map((id, slot) => ({ index: p.start + slot, ...meta(id), ...(slots[slot] ? { rect: slots[slot] } : { hidden: true }) })),
        };
      }),
      ...(s.tucked && Object.keys(s.tucked).length ? { tucked: Object.fromEntries(Object.entries(s.tucked).map(([e, ids]) => [e, (ids ?? []).map(meta)])) } : {}),
      // Edge sidebars ("pinned" windows): open = kept open, taking room from the layout (px size).
      sidebars: Object.fromEntries(EDGES.filter((e) => s.tucked?.[e]?.length).map((e) => [e, {
        open: !!s.tuckKeep?.includes(e), size: s.tuckSize?.[e] ?? edgeSize(e, 1440, 860), windows: s.tucked![e]!,
      }])),
      closed: Object.keys(s.instances).filter((id) => !s.order.includes(id) && !Object.values(s.tucked ?? {}).some((l) => l?.includes(id))).map(meta),
    };
  }

  catalog() {
    return Object.values(APPS).filter((a) => !this.config.disabledApps?.includes(a.type)).map((a) => ({
      type: a.type, title: a.title, singleton: a.singleton, description: a.description,
      source: a.source,
      ...(a.permissions && (a.permissions.network.length || a.permissions.microphone || a.permissions.storage) ? { permissions: a.permissions } : {}),
      commands: Object.fromEntries(Object.entries(a.commands).filter(([k]) => !isInternal(a, k))),
      ...(a.settings ? { settings: Object.fromEntries(Object.entries(a.settings).map(([k, s]) => [k, { ...s, value: settingValues(a, this.config.appSettings?.[a.type])[k] }])) } : {}),
    }));
  }

  /** Presets: list, save the current glass, apply one, delete one, or pick the default for new glasses. */
  preset(action: string, name?: string, description?: string): unknown {
    const need = () => { if (!name) throw new Error(`preset ${action} needs a name`); return name; };
    switch (action) {
      case 'list': return { presets: listPresets(), default: this.config.defaultPreset || null };
      case 'save': {
        const n = need();
        const prev = listPresets().find((p) => p.name === n);
        return savePreset(capturePreset(this.state, this.config, n, description ?? prev?.description ?? ''));
      }
      case 'apply': return this.applyPreset(loadPreset(need()));
      case 'delete':
        deletePreset(need());
        if (this.config.defaultPreset === name) this.setConfig('defaultPreset', '');
        return null;
      case 'default':
        if (name && name !== 'none') loadPreset(name); // must exist
        this.setConfig('defaultPreset', name && name !== 'none' ? name : '');
        return { default: this.config.defaultPreset || null };
      default: throw new Error(`unknown preset action "${action}" (list, save, apply, delete, default)`);
    }
  }

  /** Put a preset's frame on this glass: its look settings (global), then its sidebars, layouts and session settings. */
  applyPreset(p: Preset): { applied: string; skipped: string[] } {
    for (const [k, v] of Object.entries(p.look ?? {})) {
      if (!(LOOK_KEYS as readonly string[]).includes(k)) continue;
      try { this.setConfig(k, v); } catch {} // a value from an older version that no longer fits
    }
    const { actions, skipped } = presetActions(this.state, p, (type) => !!APPS[type] && !this.config.disabledApps?.includes(type));
    let s = this.state;
    for (const a of actions) {
      if (a.type === 'desktop.layout' && this.config.nestedView) continue; // no desktops in the nested view
      try { s = reduce(s, a).state; } catch {}
    }
    this.commit(s);
    return { applied: p.name, skipped };
  }

  handle(env: Envelope): Reply {
    try {
      switch (env.op) {
        case 'ping': return { ok: true, result: { session: this.sessionId, pid: process.pid } };
        case 'hook': this.hook(env.payload); return { ok: true, result: null };
        case 'dispatch': return { ok: true, result: this.dispatch(env.action as Action) };
        case 'view': return { ok: true, result: this.view() };
        case 'catalog': return { ok: true, result: this.catalog() };
        case 'guide': return { ok: true, result: guideFor({ ...this.config, windowMode: this.state.settings.windowMode }) };
        case 'mods': return { ok: true, result: this.mods };
        case 'state': {
          const id = env.id as string | undefined;
          if (!id) return { ok: true, result: this.state };
          if (!this.state.instances[id]) throw new Error(`no such instance "${id}"`);
          return { ok: true, result: { instance: this.state.instances[id], state: this.state.appState[id] } };
        }
        case 'config': {
          if (env.key !== undefined) return { ok: true, result: this.setConfig(String(env.key), env.value) };
          return { ok: true, result: this.config };
        }
        case 'preset': return { ok: true, result: this.preset(String(env.action ?? 'list'), env.name as string | undefined, env.description as string | undefined) };
        case 'quit': setTimeout(() => this.onQuit(), 20); return { ok: true, result: null };
        default: throw new Error(`unknown op "${(env as any).op}"`);
      }
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  }

  /** Listen on the session socket. Rcopies if another live glass already owns it. */
  async listen(): Promise<string> {
    const path = socketPath(this.sessionId);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try { chmodSync(dirname(path), 0o700); } catch {}
    if (existsSync(path)) {
      if (await isLive(path)) throw new Error(`Claude Glass already running for session ${this.sessionId}`);
      unlinkSync(path);
    }
    this.server = net.createServer((sock) => {
      let buf = '';
      sock.setEncoding('utf8');
      sock.on('data', (chunk) => {
        buf += chunk;
        if (buf.length > 20_000_000) { sock.destroy(); return; }
        const nl = buf.indexOf('\n');
        if (nl === -1) return;
        const line = buf.slice(0, nl);
        buf = '';
        let reply: Reply;
        try { reply = this.handle(JSON.parse(line)); } catch (e: any) { reply = { ok: false, error: `bad request: ${e.message}` }; }
        sock.end(JSON.stringify(reply) + '\n');
      });
      sock.on('error', () => {});
    });
    await new Promise<void>((res, rej) => { this.server!.once('error', rej); this.server!.listen(path, () => res()); });
    try { chmodSync(path, 0o600); } catch {}
    return path;
  }

  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.save(); }, 250);
  }

  save() {
    writeJsonAtomic(statePath(this.sessionId), this.state);
    // Unreferenced file copies go at most every half hour (and at the first save after opening).
    if (Date.now() - this.lastPrune > 30 * 60 * 1000) { this.lastPrune = Date.now(); this.pruneFiles(); }
  }

  async close() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    this.save();
    const path = socketPath(this.sessionId);
    await new Promise<void>((res) => (this.server ? this.server.close(() => res()) : res()));
    try { unlinkSync(path); } catch {}
  }
}

export function loadState(sessionId: string): GlassState | null {
  try {
    const s = JSON.parse(readFileSync(statePath(sessionId), 'utf8')) as GlassState;
    if (s.version !== 1) return null;
    s.autoOpened ??= [];
    s.ui ??= { viewingDesktop: 0 };
    return s;
  } catch {
    return null;
  }
}

export function isLive(path: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((res) => {
    const sock = net.connect(path);
    const t = setTimeout(() => { sock.destroy(); res(false); }, timeoutMs);
    sock.on('connect', () => { clearTimeout(t); sock.write('{"op":"ping"}\n'); });
    sock.on('data', () => { clearTimeout(t); sock.destroy(); res(true); });
    sock.on('error', () => { clearTimeout(t); res(false); });
  });
}
