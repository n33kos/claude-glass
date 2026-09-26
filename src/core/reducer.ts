// The one reducer. UI drags, CLI commands, and hooks all end up here.
import { APPS, getApp } from '../apps/registry';
import { isLayout } from './layout';
import type { Action, GlassState, InstanceMeta, SessionInfo } from './types';

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
    settings: { autoOpen: { changes: true, plan: true, images: true } },
    ui: { viewingDesktop: 0 },
    autoOpened: [],
  };
  // Default windows: conversation + terminal.
  let s = reduce(base, { type: 'instance.create', appType: 'terminal' }).state;
  s = reduce(s, { type: 'instance.create', appType: 'conversation' }).state;
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

/**
 * Put pinned windows at their pinned slots and flow the rest, in their current relative order,
 * around them. A pin past the end of the open windows lands at the end (no holes).
 */
export function arrange(order: string[], pinned: Record<string, number> = {}): string[] {
  const pins = order.filter((id) => id in pinned).sort((a, b) => pinned[a] - pinned[b]);
  if (!pins.length) return order;
  const free = order.filter((id) => !(id in pinned));
  const out: string[] = [];
  while (free.length || pins.length) {
    if (pins.length && (pinned[pins[0]] <= out.length || !free.length)) out.push(pins.shift()!);
    else out.push(free.shift()!);
  }
  return out;
}

function withOrder(s: GlassState, order: string[], pinned = s.pinned ?? {}): GlassState {
  const kept = Object.fromEntries(Object.entries(pinned).filter(([id]) => order.includes(id)));
  return { ...s, pinned: kept, order: arrange(order, kept) };
}

export function reduce(s: GlassState, a: Action): ReduceResult {
  const r = reduceRaw(s, a);
  if (r.state.order === s.order && r.state.pinned === s.pinned) return r;
  return { ...r, state: withOrder(r.state, r.state.order) };
}

function reduceRaw(s: GlassState, a: Action): ReduceResult {
  switch (a.type) {
    case 'window.open':
      requireInstance(s, a.id);
      return { state: { ...s, order: openAtZero(s.order, a.id) } };

    case 'window.close':
      requireInstance(s, a.id);
      return { state: { ...s, order: s.order.filter((x) => x !== a.id) } };

    case 'window.move': {
      requireInstance(s, a.id);
      // Moving a pinned window re-pins it at the new slot.
      if (s.pinned && a.id in s.pinned) return reduceRaw(s, { type: 'window.pin', id: a.id, index: a.index });
      const pinned = s.pinned ?? {};
      if (!Object.keys(pinned).length) {
        const rest = s.order.filter((x) => x !== a.id);
        const i = clampIndex(a.index, rest.length);
        return { state: { ...s, order: [...rest.slice(0, i), a.id, ...rest.slice(i)] } };
      }
      // With pins, work in free-slot space: a target on a pinned slot slides to the nearest free
      // slot in the direction of travel, then the window takes that free slot's rank.
      const order = s.order.includes(a.id) ? s.order : arrange(openAtZero(s.order, a.id), pinned);
      const free = (k: number) => k >= 0 && k < order.length && !(order[k] in pinned);
      const cur = order.indexOf(a.id);
      const want = clampIndex(a.index, order.length - 1);
      const dir = want >= cur ? 1 : -1;
      let j = want;
      while (!free(j) && j >= 0 && j < order.length) j += dir;
      if (!free(j)) for (j = want; !free(j); j -= dir);
      const rest = order.filter((x) => x !== a.id && !(x in pinned));
      const rank = order.slice(0, j).filter((x) => !(x in pinned)).length;
      const flowed = [...rest.slice(0, rank), a.id, ...rest.slice(rank)];
      return { state: { ...s, order: arrange([...flowed, ...order.filter((x) => x in pinned)], pinned) } };
    }

    case 'window.pin': {
      requireInstance(s, a.id);
      const order = s.order.includes(a.id) ? s.order : openAtZero(s.order, a.id);
      const index = clampIndex(a.index ?? order.indexOf(a.id), order.length - 1);
      // One window per pinned slot: pinning onto a pinned slot unpins the old occupant.
      const pinned = Object.fromEntries(Object.entries(s.pinned ?? {}).filter(([id, i]) => id !== a.id && i !== index));
      const rest = order.filter((x) => x !== a.id);
      return { state: { ...s, order: [...rest.slice(0, index), a.id, ...rest.slice(index)], pinned: { ...pinned, [a.id]: index } } };
    }

    case 'window.unpin': {
      requireInstance(s, a.id);
      const { [a.id]: _, ...pinned } = s.pinned ?? {};
      return { state: { ...s, pinned } };
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

    case 'settings.set': {
      const settings = structuredClone(s.settings) as any;
      const path = a.key.split('.');
      let obj = settings;
      for (const k of path.slice(0, -1)) obj = obj[k] ??= {};
      obj[path[path.length - 1]] = a.value;
      return { state: { ...s, settings } };
    }

    case 'session.update':
      return { state: { ...s, session: { ...s.session, ...a.patch } } };

    case 'ui.viewDesktop':
      return { state: { ...s, ui: { ...s.ui, viewingDesktop: Math.max(0, Math.floor(a.index)) } } };

    default:
      throw new Error(`unknown action ${(a as any)?.type}`);
  }
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
