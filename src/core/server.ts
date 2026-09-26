// CanvasCore: owns one session's state, persistence, and the Unix socket. Plain Node — Electron
// main wraps it, integration tests run it directly.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import net from 'node:net';
import { basename, dirname } from 'node:path';
import { APPS, INTERNAL_COMMANDS } from '../apps/registry';
import { coerceConfigValue, loadConfig, saveConfig, writeJsonAtomic } from './config';
import { applyHook } from './hooks';
import { computeDesktops } from './layout';
import { filesDir, sessionDir, socketPath, statePath } from './paths';
import { initialState, reduce } from './reducer';
import type { Action, CanvasState, Envelope, GlobalConfig, Reply } from './types';

export type Listener = (state: CanvasState, config: GlobalConfig) => void;

export class CanvasCore {
  state: CanvasState;
  config: GlobalConfig;
  private listeners = new Set<Listener>();
  private saveTimer: NodeJS.Timeout | null = null;
  private server: net.Server | null = null;
  onQuit: () => void = () => {};

  constructor(readonly sessionId: string, cwd: string) {
    mkdirSync(sessionDir(sessionId), { recursive: true });
    this.config = loadConfig();
    this.state = loadState(sessionId) ?? initialState({ id: sessionId, cwd });
    if (cwd && !this.state.session.cwd) this.state = reduce(this.state, { type: 'session.update', patch: { cwd } }).state;
    // Reopened canvas: fresh start time is not interesting, but "ended" must be cleared.
    this.state = reduce(this.state, { type: 'session.update', patch: { endedAt: undefined, activity: 'idle' } }).state;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private commit(next: CanvasState) {
    if (next === this.state) return;
    this.state = next;
    this.scheduleSave();
    for (const fn of this.listeners) fn(this.state, this.config);
  }

  dispatch(action: Action): unknown {
    const { state, result } = reduce(this.state, action);
    this.commit(state);
    return result ?? null;
  }

  hook(payload: unknown): void {
    this.commit(applyHook(this.state, payload, {
      ingestFile: (p) => this.ingestFile(p),
      readText: (p) => { try { return statSync(p).size < 1_000_000 ? readFileSync(p, 'utf8') : null; } catch { return null; } },
    }));
  }

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
    const v = coerceConfigValue(key as keyof GlobalConfig, value);
    this.config = { ...this.config, [key]: v };
    saveConfig(this.config);
    for (const fn of this.listeners) fn(this.state, this.config);
    return this.config;
  }

  view() {
    const s = this.state;
    const pages = computeDesktops(s.order, s.desktops, this.config.defaultLayout);
    const meta = (id: string) => ({ id, type: s.instances[id].type, title: s.instances[id].title });
    return {
      session: { id: s.session.id, title: s.session.title, cwd: s.session.cwd, activity: s.session.activity, ended: !!s.session.endedAt },
      userViewingDesktop: s.ui.viewingDesktop,
      desktops: pages.map((p) => ({ desktop: p.index, layout: p.layout, windows: p.windows.map((id, slot) => ({ index: p.start + slot, ...meta(id), ...(s.pinned?.[id] != null ? { pinned: true } : {}) })) })),
      closed: Object.keys(s.instances).filter((id) => !s.order.includes(id)).map(meta),
    };
  }

  catalog() {
    return Object.values(APPS).map((a) => ({
      type: a.type, title: a.title, singleton: a.singleton, description: a.description,
      commands: Object.fromEntries(Object.entries(a.commands).filter(([k]) => !INTERNAL_COMMANDS.has(k))),
    }));
  }

  handle(env: Envelope): Reply {
    try {
      switch (env.op) {
        case 'ping': return { ok: true, result: { session: this.sessionId, pid: process.pid } };
        case 'hook': this.hook(env.payload); return { ok: true, result: null };
        case 'dispatch': return { ok: true, result: this.dispatch(env.action as Action) };
        case 'view': return { ok: true, result: this.view() };
        case 'catalog': return { ok: true, result: this.catalog() };
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
        case 'quit': setTimeout(() => this.onQuit(), 20); return { ok: true, result: null };
        default: throw new Error(`unknown op "${(env as any).op}"`);
      }
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  }

  /** Listen on the session socket. Rejects if another live canvas already owns it. */
  async listen(): Promise<string> {
    const path = socketPath(this.sessionId);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try { chmodSync(dirname(path), 0o700); } catch {}
    if (existsSync(path)) {
      if (await isLive(path)) throw new Error(`canvas already running for session ${this.sessionId}`);
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
  }

  async close() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    this.save();
    const path = socketPath(this.sessionId);
    await new Promise<void>((res) => (this.server ? this.server.close(() => res()) : res()));
    try { unlinkSync(path); } catch {}
  }
}

export function loadState(sessionId: string): CanvasState | null {
  try {
    const s = JSON.parse(readFileSync(statePath(sessionId), 'utf8')) as CanvasState;
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
