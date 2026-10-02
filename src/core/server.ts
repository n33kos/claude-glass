// GlassCore: owns one session's state, persistence, and the Unix socket. Plain Node — Electron
// main wraps it, integration tests run it directly.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import net from 'node:net';
import { basename, dirname } from 'node:path';
import { APPS, isInternal } from '../apps/registry';
import { appInfo, clip, coerceSetting, settingValues, storedValues, type AppDef, type AppHookEvent, type AppHookGlass } from '../apps/types';
import type { ActionState } from '../apps/action';
import { summarizeTool } from '../apps/terminal';
import { coerceConfigValue, loadConfig, saveConfig, settingKey, writeJsonAtomic } from './config';
import { guideFor } from './guide';
import { capturePreset, deletePreset, listPresets, loadPreset, LOOK_KEYS, presetActions, savePreset, type Preset } from './presets';
import { applyEvent, type EventContext, type GlassEvent } from './events';
import { loadApps, type AppReport } from './customApps';
import { StoredFiles } from './stored';
import { formatView } from './viewtext';
import { isHookable, collectHooks, runHooks, subscriptions, whileAsking, type AppHook } from './apphooks';
import { computeDesktops, cornerHeight, desktopsFor, DOCKS, edgeSize, effectiveLayout, isCorner, LAYOUTS, nestedSlots } from './layout';
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
  private conns = new Set<net.Socket>();
  private socketIno = 0; // the socket file this glass made (a newer glass may have replaced it)
  onQuit: () => void = () => {};
  apps: AppReport[] = []; // the user's custom apps, loaded or not (and why)

  constructor(readonly sessionId: string, cwd: string) {
    mkdirSync(sessionDir(sessionId), { recursive: true });
    this.config = loadConfig();
    this.apps = loadApps();
    // Two-way apps' hooks on the session (custom apps that ask for them, loaded above).
    ({ hooks: this.appHooks, errors: this.hookErrors } = collectHooks(this.config.disabledApps ?? []));
    this.apps = this.apps.map((r) => (this.hookErrors[r.type] ? { ...r, ok: false, error: this.hookErrors[r.type] } : r));
    const saved = loadState(sessionId);
    this.state = saved ?? initialState({ id: sessionId, cwd });
    if (cwd && !this.state.session.cwd) this.state = reduce(this.state, { type: 'session.update', patch: { cwd } }).state;
    // Reopened glass: fresh start time is not interesting, but "ended" must be cleared.
    this.state = reduce(this.state, { type: 'session.update', patch: { endedAt: undefined, activity: 'idle' } }).state;
    // Public state, cached only for the types the loaded apps read.
    this.state = reduce(this.state, { type: 'shared.refresh' }).state;
    // A brand-new glass starts from the default preset, if the user picked one.
    if (!saved && this.config.defaultPreset) {
      try { this.applyPreset(loadPreset(this.config.defaultPreset)); } catch {}
    }
    // Apps' project and global values, from their files.
    this.storedFiles = new StoredFiles(() => this.state, (a) => this.commit(reduce(this.state, a).state));
    this.storedFiles.load();
  }

  private storedFiles: StoredFiles;

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private commit(next: GlassState) {
    if (next === this.state) return;
    const prev = this.state;
    this.state = next;
    this.storedFiles?.sync(prev, next);
    this.settleRequests(prev);
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

  /**
   * Run one reducer action. `from` is who asked: the glass's own UI (the renderer, over IPC) or
   * the socket (the CLI: Claude, the user's shell, the mod). A two-way app's view commands answer
   * back into the Claude session, so only the UI may run them: nothing on the socket can approve
   * anything.
   */
  dispatch(action: Action, from: 'ui' | 'socket' = 'socket'): unknown {
    if (from !== 'ui' && action.type === 'attach.add') throw new Error('only the glass\'s own window can attach things to the next prompt');
    if (from !== 'ui' && action.type === 'app.command') {
      const app = APPS[this.state.instances[action.id]?.type ?? ''];
      if (app?.permissions?.twoWay && appInfo(app).viewCommands.includes(action.command)) {
        throw new Error(`"${action.command}" answers back into the Claude session: only the glass's own window can do that`);
      }
    }
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

  // ---- Approvals (the Action app; docs/plans/mods.md, Phase 2) ----------------------------------
  private waiters = new Map<string, Set<(r: unknown) => void>>();

  private actionSettings() {
    const app = APPS.action;
    return app ? settingValues(app, this.config.appSettings?.action) as { approvals: boolean; keepAnswered: boolean; holdMinutes: number; questions: boolean } : null;
  }

  private request(id: string): ActionState['requests'][number] | undefined {
    return (this.state.appState.action as ActionState | undefined)?.requests.find((r) => r.id === id);
  }

  /**
   * The mod asks the user's permission through the glass: a card in the Action app (brought to
   * the front), answered from the glass's UI. Off (the app turned off, or approvals off): the mod
   * leaves it to Claude Code's own prompt.
   */
  actionRequest(req: { kind?: unknown; tool?: unknown; input?: unknown; canAlways?: unknown; force?: boolean }): { id: string; holdMs: number; summary: string } | { off: string } {
    const settings = this.actionSettings();
    if (!settings || this.config.disabledApps?.includes('action')) return { off: 'the Action app is turned off' };
    const question = req.kind === 'question';
    // (force: an app's own question, or Claude asking through the glass; the settings are about Claude Code's prompts)
    if (!req.force && (question ? !settings.questions : !settings.approvals)) return { off: question ? 'questions from the glass are off' : 'approvals from the glass are off' };
    const tool = String(req.tool ?? (question ? 'AskUserQuestion' : '?'));
    const id = `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    let s = this.state;
    if (!s.instances.action) s = reduce(s, { type: 'instance.create', appType: 'action', open: false }).state;
    const args = question
      ? { id, tool, kind: 'question', questions: (req.input as { questions?: unknown } | undefined)?.questions }
      : { id, tool, summary: summarizeTool(tool, req.input), detail: requestDetail(tool, req.input), canAlways: req.canAlways === true };
    s = reduce(s, { type: 'app.command', id: 'action', command: 'request', args }).state;
    // It's what the user needs to look at now: to the front (a docked one stays where it is).
    if (!Object.values(s.tucked ?? {}).some((l) => l?.includes('action'))) s = reduce(s, { type: 'window.open', id: 'action' }).state;
    this.commit(s);
    return { id, holdMs: Math.round(settings.holdMinutes * 60_000), summary: question ? this.request(id)?.summary ?? 'Claude has a question' : summarizeTool(tool, req.input) };
  }

  /** Wait (up to ms) for a request's answer. Pending, answered (with the choice), or gone. */
  actionWait(id: string, ms: number): Promise<unknown> {
    const now = () => {
      const r = this.request(id);
      return !r ? { status: 'gone' } : r.status === 'pending' ? null : answered(r);
    };
    const ready = now();
    if (ready) return Promise.resolve(ready);
    return new Promise((resolve) => {
      const set = this.waiters.get(id) ?? new Set();
      const done = (r: unknown) => { clearTimeout(t); set.delete(done); resolve(r); };
      const t = setTimeout(() => done({ status: 'pending' }), Math.max(0, Math.min(30_000, ms)));
      set.add(done);
      this.waiters.set(id, set);
    });
  }

  /** The request was settled elsewhere (the terminal), timed out, or the turn was interrupted. */
  actionClose(id: string, by: unknown, choice: unknown, answers?: unknown): void {
    if (!this.request(id)) return;
    this.dispatch({ type: 'app.command', id: 'action', command: 'close', args: { id, by, choice, ...(answers && typeof answers === 'object' ? { answers } : {}) } });
  }

  /** After each change: answer whoever waits on a settled request; tidy up when nothing's pending. */
  private settleRequests(prev: GlassState): void {
    const before = (prev.appState.action as ActionState | undefined)?.requests;
    const after = (this.state.appState.action as ActionState | undefined)?.requests;
    if (!after || before === after) return;
    for (const [id, set] of this.waiters) {
      const r = after.find((x) => x.id === id);
      if (r && r.status === 'pending') continue;
      const reply = r ? answered(r) : { status: 'gone' };
      for (const fn of [...set]) fn(reply);
      this.waiters.delete(id);
    }
    const settled = after.some((r) => r.status === 'answered' && !before?.find((b) => b.id === r.id && b.status === 'answered'));
    if (settled && !this.actionSettings()?.keepAnswered) {
      // A moment to see what was chosen, then the card goes, and the window if nothing's left.
      setTimeout(() => {
        const reqs = (this.state.appState.action as ActionState | undefined)?.requests ?? [];
        let s = this.state;
        for (const r of reqs) if (r.status === 'answered') s = reduce(s, { type: 'app.command', id: 'action', command: 'dismiss', args: { id: r.id } }).state;
        const docked = Object.values(s.tucked ?? {}).some((l) => l?.includes('action'));
        if (!reqs.some((r) => r.status === 'pending') && !docked && s.order.includes('action')) s = reduce(s, { type: 'window.close', id: 'action' }).state;
        this.commit(s);
      }, 1500).unref?.();
    }
  }

  // ---- The guide Claude was last given (session start, `open`, or with a prompt) ---------------
  private guideGiven: string | null = null;
  private guide(): string { return guideFor({ ...this.config, windowMode: this.state.settings.windowMode }); }

  // ---- Two-way apps' hooks (src/core/apphooks.ts) and attachments -----------------------------
  appHooks: AppHook[] = [];
  hookErrors: Record<string, string> = {};

  /** What the mod should forward: the events two-way apps hook, and prompt.submit while something's attached. */
  subscriptions(): Record<string, string[]> {
    const subs = subscriptions(this.appHooks);
    if (this.state.attachments?.length) subs['prompt.submit'] = ['*'];
    return subs;
  }

  /** The handle a two-way app's hook gets on the glass. */
  private glassFor(app: AppDef): AppHookGlass {
    return {
      app: app.type,
      stored: storedValues(app, this.state.stored?.[app.type]),
      store: (patch) => this.dispatch({ type: 'stored.set', app: app.type, values: patch }),
      ask: (question, options = []) => whileAsking(this.askUser(app.type, question, options)),
    };
  }

  /** A question from an app (or Claude's glass tool), as an Action card; the user's answer. */
  async askUser(from: string, question: string, options: (string | { label: string; description?: string })[], timeoutMs = 9.5 * 60_000): Promise<string> {
    // (just under the ten minutes the mod's CLI call may take, so it hears "no answer" rather than a timeout)
    const req = this.actionRequest({ kind: 'question', tool: from, input: { questions: [{ question, multiSelect: false, options: options.map((o) => (typeof o === 'string' ? { label: o } : o)) }] }, force: true });
    if ('off' in req) throw new Error(req.off);
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const r = await this.actionWait(req.id, 25_000) as { status: string; answers?: Record<string, string> };
      if (r.status === 'answered') return Object.values(r.answers ?? {})[0] ?? '';
      if (r.status === 'gone') throw new Error('the question was dismissed');
    }
    this.actionClose(req.id, 'timeout', undefined);
    throw new Error('no answer');
  }

  /**
   * An event the mod forwards (`claude-glass hook <event>`): attachments join a prompt's context,
   * then the apps' hooks run. `{ e }` to pass it on (maybe changed), `{ answer }` to answer it.
   */
  async hook(event: string, e: Record<string, unknown>): Promise<unknown> {
    if (!isHookable(event)) throw new Error(`can't hook "${event}"`);
    let ev = { ...e };
    if (event === 'prompt.submit') {
      const context = Array.isArray(ev.context) ? ev.context.map(String) : [];
      // The guide follows the settings: when what Claude was told no longer matches (a setting
      // changed, or the glass opened mid-session), the current guide rides this prompt. Unchanged,
      // nothing is added, so the prompt cache stays warm.
      const guide = this.guide();
      if (guide !== this.guideGiven) {
        context.push(`Claude Glass: ${this.guideGiven ? 'the user changed how their glass works' : 'the user\'s glass is open'}. This is the current guide (it replaces any earlier one):\n\n${guide}`);
        this.guideGiven = guide;
      }
      // What the user attached for this prompt (point and ask), once.
      if (this.state.attachments?.length) {
        context.push(...this.state.attachments.map((a) => `From the user's Claude Glass (${a.label}):\n${a.text}`));
        this.dispatch({ type: 'attach.clear' });
      }
      // viewContext: what's on the glass now, so Claude ranks windows from what's really there.
      if (this.config.viewContext === true) context.push(`What's on the user's glass right now:\n${formatView(this.view())}`);
      ev = { ...ev, context };
    }
    return runHooks(this.appHooks, event, ev, (app) => this.glassFor(app));
  }

  // ---- Controls: the glass asking the mod to do something (interrupt) -------------------------
  // Not glass state: a short queue the mod collects with `claude-glass watch`, a CLI call that
  // waits on the socket until there's something (or a while passes). Only the glass's own
  // window adds to it (main's IPC), never the socket.
  private controls: ({ kind: 'interrupt'; at: number } | { kind: 'prompt'; text: string; at: number })[] = [];
  private watchers = new Set<() => void>();

  /** The user pressed Stop in the glass (with the interrupt button on). */
  interrupt(): void {
    if (this.config.interruptButton !== true || this.state.session.activity !== 'working') return;
    this.controls.push({ kind: 'interrupt', at: Date.now() });
    for (const fn of [...this.watchers]) fn();
  }

  /** The user messaged Claude from the glass (Conversation's box, or the header field when askBox is
   *  on): the mod submits it as their prompt. */
  submitPrompt(text: string, from: 'conversation' | 'header'): void {
    const t = String(text ?? '').trim().slice(0, 10_000);
    if ((from === 'header' && this.config.askBox !== true) || !t) return;
    this.controls.push({ kind: 'prompt', text: t, at: Date.now() });
    for (const fn of [...this.watchers]) fn();
  }

  /** The mod's wait for controls: whatever is queued (dropping stale ones), or [] after ms. */
  watchControls(ms: number): Promise<unknown[]> {
    // A Stop goes stale fast; a prompt waits (the mod submits it once Claude is idle).
    const take = () => { const fresh = this.controls.filter((c) => c.kind === 'prompt' || Date.now() - c.at < 15_000); this.controls = []; return fresh; };
    if (this.controls.length) return Promise.resolve(take());
    return new Promise((resolve) => {
      const done = () => { clearTimeout(t); this.watchers.delete(done); resolve(take()); };
      const t = setTimeout(done, Math.max(0, Math.min(30_000, ms)));
      this.watchers.add(done);
    });
  }

  /** Session events from the glass mod, in order (one batch per `claude-glass event`). */
  events(events: unknown[]): void {
    const ctx: EventContext = {
      ingestFile: (p) => this.ingestFile(p),
      disabled: new Set(this.config.disabledApps ?? []),
      windowMode: this.state.settings.windowMode,
      readText: (p) => { try { return statSync(p).size < 1_000_000 ? readFileSync(p, 'utf8') : null; } catch { return null; } },
      // Lighting a window is the signal layer's: off means the glass only moves windows.
      follow: Object.fromEntries((['edits', 'plans', 'tests', 'web', 'images', 'agents'] as const).map((k) => {
        const mode = this.config[`follow${k[0].toUpperCase()}${k.slice(1)}` as `follow${Capitalize<typeof k>}`];
        return [k, this.config.signals === false && mode !== 'off' ? (mode === 'light' ? 'off' : 'front') : mode];
      })),
    };
    let s = this.state;
    for (const ev of events) s = applyEvent(s, ev as GlassEvent, ctx);
    this.commit(s);
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

  setConfig(rawKey: string, value: unknown): GlobalConfig {
    const key = settingKey(rawKey); // old names (dockAutoHide...) still work
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
      // Docks (edges and corners; "sidebars" for compatibility): open = kept open, taking room from
      // the layout (px size: width for sides and corners, height for top/bottom; corners also a height).
      sidebars: Object.fromEntries(DOCKS.filter((e) => s.tucked?.[e]?.length).map((e) => [e, {
        open: !!s.tuckKeep?.includes(e), ...(s.tuckFloat?.includes(e) ? { float: true } : {}), size: s.tuckSize?.[e] ?? edgeSize(e, 1440, 860),
        ...(isCorner(e) ? { height: s.tuckHeight?.[e] ?? cornerHeight(e, 860) } : {}), windows: s.tucked![e]!,
      }])),
      ...(s.overlays?.length ? { overlays: s.overlays.filter((id) => s.instances[id]).map(meta) } : {}),
      closed: Object.keys(s.instances).filter((id) => !s.order.includes(id) && !s.overlays?.includes(id) && !Object.values(s.tucked ?? {}).some((l) => l?.includes(id))).map(meta),
    };
  }

  catalog() {
    return Object.values(APPS).filter((a) => !this.config.disabledApps?.includes(a.type)).map((a) => ({
      type: a.type, title: a.title, singleton: a.singleton, description: a.description,
      source: a.source,
      ...(a.permissions && (a.permissions.network.length || a.permissions.microphone || a.permissions.storage || a.permissions.sharedSignIn || a.permissions.twoWay) ? { permissions: a.permissions } : {}),
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
    for (const [old, v] of Object.entries(p.look ?? {})) {
      const k = settingKey(old); // presets saved before a rename
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
        // (the reply tells the mod which events to forward, so that costs it no call of its own)
        case 'event': this.events(Array.isArray(env.events) ? env.events : [env.event]); return { ok: true, result: { hooks: this.subscriptions() } };
        case 'dispatch': return { ok: true, result: this.dispatch(env.action as Action, 'socket') };
        case 'action.request': return { ok: true, result: this.actionRequest((env.request ?? {}) as Record<string, unknown>) };
        case 'action.close': this.actionClose(String(env.id), env.by, env.choice, env.answers); return { ok: true, result: null };        case 'view': return { ok: true, result: this.view() };
        case 'catalog': return { ok: true, result: this.catalog() };
        case 'guide': return { ok: true, result: (this.guideGiven = this.guide()) };
        case 'apps': return { ok: true, result: this.apps };
        case 'stored': {
          // An app's persistent values, defaults filled in (`claude-glass stored <type>`).
          const app = APPS[String(env.app)];
          if (!app) throw new Error(`unknown app "${env.app}"`);
          if (!app.stored) throw new Error(`${app.type} keeps no stored values`);
          return { ok: true, result: { values: storedValues(app, this.state.stored?.[app.type]), scopes: Object.fromEntries(Object.entries(app.stored).map(([k, s]) => [k, s.scope])) } };
        }
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
        // The socket goes at once: `close` then `open` must not race this glass's shutdown.
        case 'quit': setTimeout(() => { this.releaseSocket(); this.onQuit(); }, 20); return { ok: true, result: null };
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
      this.conns.add(sock);
      sock.on('close', () => this.conns.delete(sock));
      let buf = '';
      sock.setEncoding('utf8');
      sock.on('data', (chunk) => {
        buf += chunk;
        if (buf.length > 20_000_000) { sock.destroy(); return; }
        const nl = buf.indexOf('\n');
        if (nl === -1) return;
        const line = buf.slice(0, nl);
        buf = '';
        let env: Envelope;
        try { env = JSON.parse(line); } catch (e: any) { sock.end(JSON.stringify({ ok: false, error: `bad request: ${e.message}` }) + '\n'); return; }
        // Ops that answer later (the connection stays open): an approval's answer, the mod's controls.
        const later = env?.op === 'action.wait' ? this.actionWait(String(env.id), Number(env.ms ?? 1000))
          : env?.op === 'watch' ? this.watchControls(Number(env.ms ?? 20_000))
          : env?.op === 'hook' ? this.hook(String(env.event), (env.e ?? {}) as Record<string, unknown>)
          // Claude asks the user through the glass (the mod's tool): an Action card, then the answer.
          : env?.op === 'ask' ? this.askUser('Claude', String(env.question ?? ''), Array.isArray(env.options) ? env.options : []).then((answer) => ({ answer })) : null;
        if (later) {
          void later.then((result) => ({ ok: true, result }), (e) => ({ ok: false, error: e?.message ?? String(e) }))
            .then((reply) => { if (!sock.destroyed) sock.end(JSON.stringify(reply) + '\n'); });
          return;
        }
        sock.end(JSON.stringify(this.handle(env)) + '\n');
      });
      sock.on('error', () => {});
    });
    await new Promise<void>((res, rej) => { this.server!.once('error', rej); this.server!.listen(path, () => res()); });
    try { chmodSync(path, 0o600); } catch {}
    try { this.socketIno = statSync(path).ino; } catch {}
    this.storedFiles.watch(); // other glasses' writes to shared app values
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

  /** Let go of the socket now, so a new glass can take it; only if it's still this glass's own. */
  releaseSocket() {
    const path = socketPath(this.sessionId);
    try { if (this.socketIno && statSync(path).ino === this.socketIno) unlinkSync(path); } catch {}
    this.socketIno = 0;
  }

  async close() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    this.save();
    this.storedFiles.close();
    this.releaseSocket();
    // Held connections (the mod's waits) would keep the server open: end them.
    for (const s of this.conns) s.destroy();
    await new Promise<void>((res) => (this.server ? this.server.close(() => res()) : res()));
  }
}

/** A settled request, as the mod's wait sees it. */
const answered = (r: ActionState['requests'][number]) => ({ status: 'answered', choice: r.answer?.choice, by: r.answer?.by, ...(r.answer?.answers ? { answers: r.answer.answers } : {}) });

/** What an approval card shows under its summary: the command, the change, the address. */
export function requestDetail(tool: string, input: any): string | undefined {
  input = input ?? {};
  const lines = (t: unknown, mark: string) => String(t ?? '').split('\n').map((l) => mark + l).join('\n');
  switch (tool) {
    case 'Bash': { // the summary already shows a short one
      const c = String(input.command ?? '');
      return c.length > 100 || c.includes('\n') ? clip(c, 4000) : undefined;
    }
    case 'Edit': return clip(`${lines(input.old_string, '- ')}\n${lines(input.new_string, '+ ')}`, 4000);
    case 'MultiEdit': return clip((Array.isArray(input.edits) ? input.edits : []).map((e: any) => `${lines(e.old_string, '- ')}\n${lines(e.new_string, '+ ')}`).join('\n…\n'), 4000);
    case 'Write': return clip(lines(input.content, '+ '), 4000);
    case 'WebFetch': return [input.url, input.prompt].filter(Boolean).join('\n') || undefined;
    default: {
      const json = JSON.stringify(input, null, 2);
      return json && json !== '{}' ? clip(json, 2000) : undefined;
    }
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
