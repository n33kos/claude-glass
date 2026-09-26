// Electron main: one process per Claude session. Wraps GlassCore and hosts one BrowserWindow.
import { app, BrowserWindow, ipcMain, Menu, protocol } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { APPS } from '../apps/registry';
import { appInfo } from '../apps/types';
import { filesDir } from '../core/paths';
import { currentWeb, type BrowserState } from '../apps/browser';
import { BrowserStream } from '../core/cdp';
import { computeDesktops, desktopsFor } from '../core/layout';
import { attachBuiltinViews } from '../core/mods';
import { GlassCore } from '../core/server';
import { WebFeed, type WebInput } from './webFeed';
import type { Action, GlassState, GlobalConfig } from '../core/types';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const sessionId = arg('session');
const cwd = arg('cwd') ?? process.cwd();
if (!sessionId) {
  console.error('claude-glass main: --session is required');
  process.exit(2);
}

app.setName('Claude Glass');
protocol.registerSchemesAsPrivileged([
  { scheme: 'glass-file', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'glass-html', privileges: { standard: true, secure: true } },
  { scheme: 'glass-app', privileges: { standard: true, secure: true } },
]);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp',
};

// Freeform HTML runs in its own opaque origin (sandboxed iframe) with this CSP: inline code and
// a few script CDNs allowed, no fetch/XHR/websocket.
const HTML_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com",
  "style-src 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net",
  'font-src data: https://fonts.gstatic.com',
  'img-src data: blob:',
  "connect-src 'none'",
].join('; ');

// App views (built-in and mods) run in sandboxed frames served from glass-app://<type>/...,
// the SDK from glass-app://sdk/. Scripts from the app itself or the usual CDNs; no network.
const APP_CSP = [
  "default-src 'none'",
  "script-src glass-app: 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com",
  "style-src glass-app: 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net",
  'font-src glass-app: data: https://fonts.gstatic.com',
  'img-src glass-app: glass-file: data: blob:',
  'media-src glass-app: glass-file: data: blob:',
  'frame-src glass-html:',
  "connect-src 'none'",
].join('; ');

let core: GlassCore;
let win: BrowserWindow | null = null;
let quitting = false;

async function boot() {
  attachBuiltinViews(join(__dirname, 'apps'));
  core = new GlassCore(sessionId!, cwd);
  try {
    await core.listen();
  } catch (e: any) {
    console.error(e.message);
    app.exit(0);
    return;
  }
  core.onQuit = () => shutdown();

  // glass-file://f/<abs path> — only files inside this session's files dir, or the configured background.
  protocol.handle('glass-file', (req) => {
    const url = new URL(req.url);
    const path = resolve(decodeURIComponent(url.pathname));
    const allowed = path.startsWith(filesDir(sessionId!) + '/') || path === core.config.background;
    if (!allowed) return new Response('forbidden', { status: 403 });
    try {
      return new Response(readFileSync(path), { headers: { 'content-type': MIME[extname(path).toLowerCase()] ?? 'application/octet-stream' } });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });

  // glass-app://<type>/<path> — an app's own folder; glass-app://sdk/<file> — the SDK.
  const sdkDir = join(__dirname, 'sdk');
  protocol.handle('glass-app', (req) => {
    const url = new URL(req.url);
    const base = url.hostname === 'sdk' ? sdkDir : APPS[url.hostname]?.dir;
    if (!base) return new Response('no such app', { status: 404 });
    const path = resolve(base, '.' + decodeURIComponent(url.pathname));
    if (path !== base && !path.startsWith(base + sep)) return new Response('forbidden', { status: 403 });
    if (!existsSync(path)) return new Response('not found', { status: 404 });
    const type = MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
    const headers: Record<string, string> = { 'content-type': type };
    if (type.startsWith('text/html')) headers['content-security-policy'] = APP_CSP;
    return new Response(readFileSync(path), { headers });
  });

  // glass-html://<instanceId>/ — the html app's current document.
  protocol.handle('glass-html', (req) => {
    const id = new URL(req.url).hostname;
    const st = core.state.appState[id] as { html?: string } | undefined;
    const body = st?.html || '<!doctype html><body style="font:14px system-ui;color:#999;display:grid;place-items:center;height:90vh;margin:0">Empty canvas</body>';
    return new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': HTML_CSP } });
  });

  ipcMain.handle('glass:init', () => ({ sessionId, state: core.state, config: core.config, apps: Object.values(APPS).map(appInfo), mods: core.mods }));
  ipcMain.handle('glass:dispatch', (_e, action: Action) => {
    try { return { ok: true, result: core.dispatch(action) }; } catch (e: any) { return { ok: false, error: e.message }; }
  });
  // The browser tile's shape, so the offscreen page renders to fill it (a view hint, not state).
  ipcMain.on('glass:webAspect', (_e, aspect: number) => { webAspect = Number(aspect) || 0; for (const f of webFeeds.values()) f.fit(webAspect); });
  // Scroll/click in the glass's own copy of a fetched page (never Claude's browser).
  ipcMain.on('glass:webInput', (_e, input: WebInput & { id?: string }) => {
    if (input && (input.type === 'wheel' || input.type === 'click')) webFeeds.get(String(input.id))?.input(input);
  });
  ipcMain.handle('glass:lastFrame', (_e, id: string) => lastFrames.get(id) ?? null);
  ipcMain.handle('glass:config', (_e, key: string, value: unknown) => {
    try { return { ok: true, result: core.setConfig(key, value) }; } catch (e: any) { return { ok: false, error: e.message }; }
  });

  // Push state patches: the reducer is immutable, so unchanged app slices keep identity.
  let lastSent: GlassState = core.state;
  let lastConfig: GlobalConfig = core.config;
  let timer: NodeJS.Timeout | null = null;
  core.subscribe(() => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (!win || win.isDestroyed()) return;
      const s = core.state;
      const changed: Record<string, unknown> = {};
      for (const id of Object.keys(s.appState)) if (s.appState[id] !== lastSent.appState[id]) changed[id] = s.appState[id];
      const { appState: _a, ...rest } = s;
      win.webContents.send('glass:patch', { ...rest, changed, config: core.config !== lastConfig ? core.config : undefined });
      lastSent = s;
      lastConfig = core.config;
    }, 30);
  });

  syncBrowserStreams();
  core.subscribe(syncBrowserStreams);

  const icon = join(__dirname, '..', 'assets', 'icon.png');
  if (process.platform === 'darwin') try { app.dock?.setIcon(icon); } catch {}
  buildMenu();
  createWindow();
}

// Browser app: one CDP screencast per open browser window with an endpoint. Frames bypass the
// reducer (a video feed, not state); the stream reports status/url/title through it.
const streams = new Map<string, BrowserStream>();
type Source = 'cdp' | 'web';
const lastFrames = new Map<string, Partial<Record<Source, string>>>();
// Fetched pages render in hidden offscreen windows, one per browser window on the desktop being
// viewed (history mode can have several), capped; others keep showing their last frame.
const webFeeds = new Map<string, WebFeed>();
const lastHomeSeq = new Map<string, number>();
const MAX_LIVE_PAGES = 4;
let webAspect = 0; // browser tile width / height, reported by the renderer

function sendFrame(id: string, source: Source, data: string) {
  lastFrames.set(id, { ...lastFrames.get(id), [source]: data });
  if (win && !win.isDestroyed()) win.webContents.send('glass:frame', { id, source, data });
}

function syncBrowserStreams() {
  const s = core.state;
  const want = new Map<string, string>();
  for (const [id, inst] of Object.entries(s.instances)) {
    const endpoint = (s.appState[id] as BrowserState | undefined)?.endpoint;
    if (inst.type === 'browser' && endpoint && s.order.includes(id)) want.set(id, endpoint);
  }
  for (const [id, stream] of streams) {
    if (want.get(id) !== stream.endpoint) { stream.stop(); streams.delete(id); }
  }
  for (const [id, endpoint] of want) {
    if (streams.has(id)) continue;
    const stream = new BrowserStream(endpoint, {
      frame: (data) => sendFrame(id, 'cdp', data),
      status: (st) => setImmediate(() => {
        if (streams.get(id) === stream) core.dispatch({ type: 'app.command', id, command: 'status', args: { ...st } });
      }),
    });
    streams.set(id, stream);
    stream.start();
  }

  // Web research: render fetched pages for browser windows on the desktop being viewed.
  const pages = computeDesktops(s.order, desktopsFor(s.desktops, core.config.nestedView), core.config.defaultLayout);
  const onScreen = pages[Math.min(s.ui.viewingDesktop, pages.length - 1)]?.windows ?? [];
  const live = new Map<string, { b: BrowserState; url: string; highlight: string | null }>();
  for (const id of onScreen) {
    if (live.size >= MAX_LIVE_PAGES || s.instances[id]?.type !== 'browser') continue;
    const b = s.appState[id] as BrowserState;
    const w = b?.view === 'web' ? currentWeb(b) : undefined;
    if (w?.kind === 'page') live.set(id, { b, url: w.url, highlight: w.highlight ?? null });
  }
  for (const [id, feed] of webFeeds) if (!live.has(id)) { feed.hide(); webFeeds.delete(id); }
  for (const [id, { b, url, highlight }] of live) {
    let feed = webFeeds.get(id);
    if (!feed) {
      const cmd = (command: string, args: Record<string, unknown>) =>
        setImmediate(() => { if (core.state.instances[id]) core.dispatch({ type: 'app.command', id, command, args }); });
      feed = new WebFeed({
        frame: (data) => sendFrame(id, 'web', data),
        title: (u, title) => cmd('web.title', { url: u, title }),
        away: (u) => cmd('web.away', { url: u }),
        found: (u, matches) => cmd('web.found', { url: u, matches }),
      });
      feed.fit(webAspect);
      webFeeds.set(id, feed);
    }
    // "Home" (back to Claude's page) is an explicit request: a bumped homeSeq.
    const home = (b.homeSeq ?? 0) !== (lastHomeSeq.get(id) ?? 0);
    lastHomeSeq.set(id, b.homeSeq ?? 0);
    feed.show(url, highlight, home);
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 720,
    minHeight: 480,
    title: `Claude Glass — ${core.state.session.title}`,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 12 },
    backgroundColor: '#0b0d14',
    show: !process.env.CLAUDE_GLASS_HIDDEN,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(join(__dirname, 'renderer', 'index.html'));
  // Launched from a CLI/hook in the background: come to the front so the user sees it.
  if (!process.env.CLAUDE_GLASS_HIDDEN) win.once('ready-to-show', () => app.focus({ steal: true }));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('closed', () => { win = null; shutdown(); });
}

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Claude Glass', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { type: 'separator' }, { label: 'Close Claude Glass', accelerator: 'CmdOrCtrl+Q', click: () => shutdown() }] },
    { label: 'Edit', submenu: [{ role: 'copy' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { label: 'Window', submenu: [{ role: 'minimize' }, { label: 'Close', accelerator: 'CmdOrCtrl+W', click: () => shutdown() }] },
  ]));
}

async function shutdown() {
  if (quitting) return;
  quitting = true;
  for (const s of streams.values()) s.stop();
  for (const f of webFeeds.values()) f.destroy();
  try { await core?.close(); } catch {}
  if (win && !win.isDestroyed()) win.destroy();
  app.exit(0);
}

app.whenReady().then(boot);
app.on('window-all-closed', () => shutdown());
process.on('SIGTERM', () => shutdown());
process.on('SIGINT', () => shutdown());
