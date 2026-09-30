// The one reducer. UI drags, CLI commands, and hooks all end up here.
import { APPS, getApp } from '../apps/registry';
import { parseColors } from './colors';
import { DOCKS, isCorner, isDock, isLayout } from './layout';
import type { Action, Dock, GlassState, InstanceMeta, SessionInfo } from './types';

export function initialState(session: Pick<SessionInfo, 'id' | 'cwd'> & Partial<SessionInfo>): GlassState {
  const base: GlassState = {
    version: 1,
    session: {
      title: session.cwd ? session.cwd.split('/').filter(Boolean).pop() ?? 'Claude' : 'Claude',
      startedAt: Date.now(),
      activity: 'idle',
      ...session,
    },
    order: [],
    desktops: ['main-left'],
    instances: {},
    appState: {},
    settings: { autoOpen: { changes: true, plan: true, images: true, web: true } },
    ui: { viewingDesktop: 0 },
    autoOpened: [],
  };
  // Default windows: conversation + terminal, and the one Images window (closed until wanted:
  // the launcher opens it, and so does the first image).
  let s = reduce(base, { type: 'instance.create', appType: 'terminal' }).state;
  s = reduce(s, { type: 'instance.create', appType: 'conversation' }).state;
  s = reduce(s, { type: 'instance.create', appType: 'image', id: 'images', title: 'Images', open: false }).state;
  return s;
}

export interface ReduceResult {
  state: GlassState;
  result?: unknown;
}

const clampIndex = (i: number, len: number) => Math.max(0, Math.min(len, Math.floor(i)));

function requireInstance(s: GlassState, id: string): InstanceMeta {
  const inst = s.instances[id];
  if (!inst) throw new Error(`no such window/app instance "${id}"`);
  return inst;
}

function nextId(s: GlassState, type: string): string {
  for (let n = 1; ; n++) if (!s.instances[`${type}-${n}`]) return `${type}-${n}`;
}

function openAtZero(order: string[], id: string): string[] {
  return [id, ...order.filter((x) => x !== id)];
}

/** Take a window out of whatever dock it's in (no-op if it isn't). */
function untuck(s: GlassState, id: string): GlassState {
  if (!s.tucked || !DOCKS.some((e) => s.tucked![e]?.includes(id))) return s;
  const tucked = Object.fromEntries(DOCKS.map((e) => [e, (s.tucked![e] ?? []).filter((x) => x !== id)]).filter(([, l]) => l.length));
  // An emptied dock can't stay open.
  return { ...s, tucked, tuckKeep: (s.tuckKeep ?? []).filter((e) => e in tucked) };
}

export const tuckedEdge = (s: GlassState, id: string): Dock | undefined => DOCKS.find((e) => s.tucked?.[e]?.includes(id));

const needDock = (d: unknown) => { if (!isDock(d)) throw new Error(`dock must be one of ${DOCKS.join(', ')}`); };

export function reduce(s: GlassState, a: Action): ReduceResult {
  const r = reduceRaw(s, a);
  // A tucked window lives in its edge panel, never in the tiling order.
  if (r.state.tucked && r.state.order.some((id) => tuckedEdge(r.state, id))) {
    r.state = { ...r.state, order: r.state.order.filter((id) => !tuckedEdge(r.state, id)) };
  }
  return r;
}

function reduceRaw(s: GlassState, a: Action): ReduceResult {
  switch (a.type) {
    case 'window.open':
      requireInstance(s, a.id);
      if (tuckedEdge(s, a.id)) return { state: s }; // already on screen, in its edge panel
      return { state: { ...s, order: openAtZero(s.order, a.id) } };

    case 'window.close': {
      requireInstance(s, a.id);
      const t = untuck(s, a.id);
      return { state: { ...t, order: t.order.filter((x) => x !== a.id) } };
    }

    case 'window.tuck': {
      requireInstance(s, a.id);
      needDock(a.edge);
      const t = untuck(s, a.id);
      const list = [...(t.tucked?.[a.edge] ?? [])];
      list.splice(a.index == null ? list.length : clampIndex(a.index, list.length), 0, a.id);
      // Reordering within a kept-open sidebar must not close it (untuck may have emptied it).
      const tuckKeep = s.tuckKeep?.includes(a.edge) ? [...(t.tuckKeep ?? []).filter((e) => e !== a.edge), a.edge] : t.tuckKeep;
      return { state: { ...t, order: t.order.filter((x) => x !== a.id), tucked: { ...t.tucked, [a.edge]: list }, tuckKeep } };
    }

    case 'tuck.keep': {
      needDock(a.edge);
      const keep = (s.tuckKeep ?? []).filter((e) => e !== a.edge);
      return { state: { ...s, tuckKeep: a.keep && s.tucked?.[a.edge]?.length ? [...keep, a.edge] : keep } };
    }

    case 'tuck.size': {
      needDock(a.edge);
      const ok = (v: unknown) => v == null || (v as number) > 0;
      if (!ok(a.size) || !ok(a.height) || (a.size == null && a.height == null)) throw new Error('tuck.size needs a positive size (or height)');
      if (a.height != null && !isCorner(a.edge)) throw new Error('only corner docks take a height');
      let state = s;
      if (a.size != null) state = { ...state, tuckSize: { ...state.tuckSize, [a.edge]: Math.round(a.size) } };
      if (a.height != null && isCorner(a.edge)) state = { ...state, tuckHeight: { ...state.tuckHeight, [a.edge]: Math.round(a.height) } };
      return { state };
    }

    case 'tuck.split': {
      needDock(a.edge);
      const n = s.tucked?.[a.edge]?.length ?? 0;
      const shares = Array.isArray(a.shares) ? a.shares.map(Number) : [];
      if (shares.length !== n || n < 2 || shares.some((x) => !(x > 0))) throw new Error(`tuck.split needs ${n} positive shares for the ${a.edge} dock`);
      const sum = shares.reduce((t, x) => t + x, 0);
      return { state: { ...s, tuckSplit: { ...s.tuckSplit, [a.edge]: shares.map((x) => Math.round((x / sum) * 1000) / 1000) } } };
    }

    case 'window.untuck': {
      requireInstance(s, a.id);
      const t = untuck(s, a.id);
      if (a.index == null) return { state: { ...t, order: openAtZero(t.order, a.id) } };
      const rest = t.order.filter((x) => x !== a.id);
      const i = clampIndex(a.index, rest.length);
      return { state: { ...t, order: [...rest.slice(0, i), a.id, ...rest.slice(i)] } };
    }

    case 'instance.delete': {
      requireInstance(s, a.id);
      // Hooks write to these on every event: they can be closed, not deleted.
      if (a.id === 'terminal' || a.id === 'conversation') throw new Error(`"${a.id}" can be closed but not deleted`);
      const t0 = untuck(s, a.id);
      const t = t0.signal?.target === a.id ? (({ signal: _s, ...rest }) => rest as GlassState)(t0) : t0; // a signal at a deleted window goes with it
      const { [a.id]: _i, ...instances } = t.instances;
      const { [a.id]: _a, ...appState } = t.appState;
      return { state: { ...t, instances, appState, order: t.order.filter((x) => x !== a.id), autoOpened: t.autoOpened.filter((x) => x !== a.id) } };
    }

    case 'window.move': {
      requireInstance(s, a.id);
      const rest = s.order.filter((x) => x !== a.id);
      const i = clampIndex(a.index, rest.length);
      return { state: { ...s, order: [...rest.slice(0, i), a.id, ...rest.slice(i)] } };
    }

    case 'window.opacity': {
      const inst = requireInstance(s, a.id);
      const v = a.value == null ? undefined : Math.max(0.2, Math.min(1, Number(a.value)));
      return { state: { ...s, instances: { ...s.instances, [a.id]: { ...inst, opacity: v } } } };
    }

    case 'desktop.layout': {
      if (!isLayout(a.layout)) throw new Error(`unknown layout "${a.layout}"`);
      const d = Math.max(0, Math.floor(a.desktop));
      const desktops = s.desktops.slice();
      while (desktops.length <= d) desktops.push(desktops[desktops.length - 1] ?? 'main-left');
      desktops[d] = a.layout;
      return { state: { ...s, desktops } };
    }

    case 'instance.create': {
      const app = getApp(a.appType);
      if (app.singleton && s.instances[app.type]) {
        const state = a.open === false ? s : { ...s, order: openAtZero(s.order, app.type) };
        return { state, result: app.type };
      }
      const id = app.singleton ? app.type : a.id ?? nextId(s, app.type);
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) throw new Error(`invalid instance id "${id}"`);
      if (s.instances[id]) {
        if (s.instances[id].type !== app.type) throw new Error(`instance "${id}" already exists with type ${s.instances[id].type}`);
        const state = a.open === false ? s : { ...s, order: openAtZero(s.order, id) };
        return { state, result: id };
      }
      const meta: InstanceMeta = { id, type: app.type, title: a.title ?? app.title, createdAt: Date.now() };
      const state: GlassState = {
        ...s,
        instances: { ...s.instances, [id]: meta },
        appState: { ...s.appState, [id]: app.init() },
        order: a.open === false ? s.order : openAtZero(s.order, id),
      };
      return { state, result: id };
    }

    case 'instance.rename': {
      const inst = requireInstance(s, a.id);
      return { state: { ...s, instances: { ...s.instances, [a.id]: { ...inst, title: String(a.title) } } } };
    }

    case 'app.command': {
      const inst = requireInstance(s, a.id);
      const app = APPS[inst.type];
      const next = app.command(s.appState[a.id] ?? app.init(), a.command, a.args ?? {});
      return { state: { ...s, appState: { ...s.appState, [a.id]: next } } };
    }

    case 'app.hook': {
      // Apps with onHook see every hook payload. Existing instances update in place; a singleton
      // is created (and auto-opened once, if it asks) the first time its onHook changes state.
      let state = s;
      for (const app of Object.values(APPS)) {
        if (!app.onHook) continue;
        const ids = Object.values(state.instances).filter((i) => i.type === app.type).map((i) => i.id);
        if (!ids.length && app.singleton) ids.push(app.type);
        for (const id of ids) {
          const exists = !!state.instances[id];
          const prev = exists ? state.appState[id] : app.init();
          let next: unknown;
          try { next = app.onHook(prev, a.payload); } catch { continue; } // a broken app never breaks hooks
          if (next === prev || next === undefined) continue;
          if (!exists) {
            state = autoCommandCreate(state, app.type, !!app.autoOpen);
          }
          state = { ...state, appState: { ...state.appState, [id]: next } };
        }
      }
      return { state };
    }

    case 'settings.set': {
      const settings = structuredClone(s.settings) as any;
      const path = a.key.split('.');
      let obj = settings;
      for (const k of path.slice(0, -1)) obj = obj[k] ??= {};
      // Colors reach the renderer's CSS: only validated hex gets in; empty clears the signal.
      const colors = a.key === 'backgroundColors' ? parseColors(a.value) : undefined;
      obj[path[path.length - 1]] = colors ? (colors.length ? colors : undefined) : a.value;
      return { state: { ...s, settings } };
    }

    case 'session.update':
      return { state: { ...s, session: { ...s.session, ...a.patch } } };

    case 'signal': {
      // Claude's signals. One at a time: a new one replaces the last. The renderer plays and decays it.
      if (a.kind === 'clear') { const { signal: _s, ...rest } = s; return { state: rest as GlassState }; }
      if (a.kind !== 'spotlight' && a.kind !== 'alert' && a.kind !== 'progress') throw new Error('signal must be spotlight, alert, progress or clear');
      if (a.kind !== 'progress') {
        if (!a.target) throw new Error(`signal ${a.kind} needs a window id`);
        requireInstance(s, a.target);
      }
      const value = a.kind === 'progress' ? Math.max(0, Math.min(1, Number(a.value ?? 0))) : undefined;
      if (a.kind === 'progress' && !Number.isFinite(value)) throw new Error('signal progress needs a value between 0 and 1');
      if (a.kind === 'progress' && value! >= 1) { const { signal: _s, ...rest } = s; return { state: rest as GlassState }; }
      const signal = {
        kind: a.kind, at: Date.now(), seq: (s.signal?.seq ?? 0) + 1,
        ...(a.target ? { target: a.target } : {}), ...(value != null ? { value } : {}), ...(a.label ? { label: String(a.label).slice(0, 120) } : {}),
      };
      return { state: { ...s, signal } };
    }

    case 'ui.viewDesktop':
      return { state: { ...s, ui: { ...s.ui, viewingDesktop: Math.max(0, Math.floor(a.index)) } } };

    default:
      throw new Error(`unknown action ${(a as any)?.type}`);
  }
}

function autoCommandCreate(s: GlassState, type: string, autoOpen: boolean): GlassState {
  let state = reduce(s, { type: 'instance.create', appType: type, open: false }).state;
  if (autoOpen && !state.autoOpened.includes(type)) {
    state = { ...reduce(state, { type: 'window.open', id: type }).state, autoOpened: [...state.autoOpened, type] };
  }
  return state;
}

/** Create-if-needed then run an app command; open the window the first time only (auto-open). */
export function autoCommand(
  s: GlassState,
  opts: { id: string; appType: string; title: string; command: string; args: Record<string, unknown>; autoOpen: boolean },
): GlassState {
  let state = s;
  if (!state.instances[opts.id]) {
    state = reduce(state, { type: 'instance.create', appType: opts.appType, id: opts.id, title: opts.title, open: false }).state;
  }
  state = reduce(state, { type: 'app.command', id: opts.id, command: opts.command, args: opts.args }).state;
  if (opts.autoOpen && !state.autoOpened.includes(opts.id)) {
    const opened = state.order.includes(opts.id) ? state : reduce(state, { type: 'window.open', id: opts.id }).state;
    state = { ...opened, autoOpened: [...state.autoOpened, opts.id] };
  }
  return state;
}
