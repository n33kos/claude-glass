// Electron main: one process per Claude session. Wraps GlassCore and hosts one BrowserWindow.
import { app, BrowserWindow, ipcMain, Menu, nativeImage, protocol, session, shell } from 'electron';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { APPS } from '../apps/registry';
import { appInfo, NO_PERMISSIONS, type AppPermissions } from '../apps/types';
import { filesDir, sessionDir, socketPath } from '../core/paths';
import { startMetrics } from './metrics';
import { currentWeb, type BrowserState } from '../apps/browser';
import { BrowserStream } from '../core/cdp';
import { computeDesktops, desktopsFor } from '../core/layout';
import { attachBuiltinViews } from '../core/mods';
import { findProjectImages, IMAGE_FILE } from '../core/projectImages';
import { GlassCore } from '../core/server';
import { ownVersion, pendingUpdate, type Installed } from '../core/update';
import { shareAppStorage } from './sharedStorage';
import { glassHome } from '../core/paths';
import { spawn } from 'node:child_process';
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
// Every glass is its own process, so each gets its own Chromium profile: two processes must never
// share one (Chromium doesn't support it; cookies and storage can corrupt). A glass home other than
// the real one (tests, demos) keeps its profile there and stays out of the dock.
if (process.env.CLAUDE_GLASS_HOME) {
  app.setPath('userData', join(process.env.CLAUDE_GLASS_HOME, 'electron', sessionId));
  if (process.platform === 'darwin') app.dock?.hide();
} else {
  const shared = app.getPath('userData'); // ~/Library/Application Support/Claude Glass
  const own = join(shared, 'glasses', sessionId);
  if (!existsSync(own)) seedProfile(shared, own);
  try { utimesSync(own, new Date(), new Date()); } catch {} // "last opened", for pruning
  app.setPath('userData', own);
  pruneProfiles(join(shared, 'glasses'), sessionId);
}

/**
 * Profiles of glasses that aren't running (no socket) and haven't been opened in 30 days go.
 * A glass that comes back starts over from the seed, like a new one.
 */
function pruneProfiles(dir: string, keep: string) {
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
  try {
    for (const id of readdirSync(dir)) {
      if (id === keep || existsSync(socketPath(id))) continue;
      const p = join(dir, id);
      if (statSync(p).mtimeMs < cutoff) rmSync(p, { recursive: true, force: true });
    }
  } catch {}
}

/**
 * A new glass starts with what apps stored before (e.g. a pairing an embedded page keeps in its
 * storage and cookies), copied from the old shared profile, so moving to per-glass profiles
 * doesn't sign anything out. Caches aren't copied. Best effort: a new glass may start empty.
 */
function seedProfile(from: string, to: string) {
  mkdirSync(to, { recursive: true });
  for (const part of ['Cookies', 'Cookies-journal', 'Local Storage', 'IndexedDB', 'WebStorage', 'Session Storage']) {
    try { if (existsSync(join(from, part))) cpSync(join(from, part), join(to, part), { recursive: true }); } catch {}
  }
}
// Developer aid: CLAUDE_GLASS_DEBUG_PORT=9333 claude-glass open → inspect the real glass over CDP.
if (process.env.CLAUDE_GLASS_DEBUG_PORT) app.commandLine.appendSwitch('remote-debugging-port', process.env.CLAUDE_GLASS_DEBUG_PORT);
protocol.registerSchemesAsPrivileged([
  { scheme: 'glass-file', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'glass-html', privileges: { standard: true, secure: true } },
  // corsEnabled: fonts always load with CORS, and app frames are sandboxed (origin "null"); the
  // SDK's font files answer with an open Access-Control-Allow-Origin (see the handler).
  { scheme: 'glass-app', privileges: { standard: true, secure: true, corsEnabled: true } },
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
// the SDK from glass-app://sdk/. Scripts from the app itself or the usual CDNs; no network unless
// the app's manifest asks for specific origins (permissions.network).
function appCsp(p: AppPermissions): string {
  const net = p.network.join(' ');
  return [
    "default-src 'none'",
    `script-src glass-app: 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com ${net}`,
    `style-src glass-app: 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net ${net}`,
    `font-src glass-app: data: https://fonts.gstatic.com ${net}`,
    `img-src glass-app: glass-file: data: blob: ${net}`,
    `media-src glass-app: glass-file: data: blob: ${net}`,
    `frame-src glass-html: ${net}`,
    `connect-src ${net || "'none'"}`,
  ].join('; ');
}

const permsOf = (url: string | undefined): AppPermissions => {
  try {
    const u = new URL(url ?? '');
    return u.protocol === 'glass-app:' ? APPS[u.hostname]?.permissions ?? NO_PERMISSIONS : NO_PERMISSIONS;
  } catch { return NO_PERMISSIONS; }
};

/**
 * Deny every permission (Electron grants all by default) except the microphone, and only to the
 * frames of apps whose manifest asks for it, or to pages they embed from their declared origins.
 */
function lockPermissions() {
  const ses = session.defaultSession;
  const micApp = (url: string | undefined) => {
    if (permsOf(url).microphone) return true;
    let origin = '';
    try { origin = new URL(url ?? '').origin; } catch { return false; }
    return Object.values(APPS).some((a) => a.permissions?.microphone && a.permissions.network.includes(origin));
  };
  const micOk = (url: string | undefined, types?: string[]) => micApp(url) && !(types ?? []).includes('video');
  ses.setPermissionRequestHandler((_wc, permission, cb, details) =>
    cb(permission === 'media' && micOk(details.requestingUrl, (details as { mediaTypes?: string[] }).mediaTypes)));
  ses.setPermissionCheckHandler((_wc, permission, origin, details) =>
    permission === 'media' && micOk((details as { requestingUrl?: string }).requestingUrl ?? origin));
}

/**
 * Apps embed pages from their declared origins inside the glass, which makes those pages
 * third-party: the browser drops their SameSite cookies (e.g. a login cookie on a WebSocket).
 * For declared origins only, keep the cookies they set and send them back to the same origin,
 * as if the page were first-party.
 */
function firstPartyCookiesForDeclaredOrigins() {
  const origins = [...new Set(Object.values(APPS).flatMap((a) => a.permissions?.network ?? []))];
  if (!origins.length) return;
  const ses = session.defaultSession;
  const urls = origins.map((o) => `${o}/*`);
  const cookieUrl = (u: string) => u.replace(/^ws/, 'http');
  ses.webRequest.onHeadersReceived({ urls }, (d, cb) => {
    const set = Object.entries(d.responseHeaders ?? {}).find(([k]) => k.toLowerCase() === 'set-cookie')?.[1] ?? [];
    for (const line of set) {
      const [pair, ...attrs] = line.split(';').map((x) => x.trim());
      const eq = pair.indexOf('=');
      if (eq < 1) continue;
      const maxAge = Number(attrs.find((a) => /^max-age=/i.test(a))?.split('=')[1]);
      const path = attrs.find((a) => /^path=/i.test(a))?.split('=')[1] || '/';
      ses.cookies.set({
        url: cookieUrl(d.url), path, name: pair.slice(0, eq), value: pair.slice(eq + 1), httpOnly: attrs.some((a) => /^httponly$/i.test(a)),
        ...(maxAge > 0 ? { expirationDate: Date.now() / 1000 + maxAge } : {}),
      }).catch(() => {});
    }
    cb({ responseHeaders: d.responseHeaders });
  });
  ses.webRequest.onBeforeSendHeaders({ urls }, (d, cb) => {
    ses.cookies.get({ url: cookieUrl(d.url) }).then((cookies) => {
      const headers = { ...d.requestHeaders };
      if (cookies.length && !Object.keys(headers).some((k) => k.toLowerCase() === 'cookie')) {
        headers.Cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
      }
      cb({ requestHeaders: headers });
    }).catch(() => cb({ requestHeaders: d.requestHeaders }));
  });
}

let core: GlassCore;
let win: BrowserWindow | null = null;
let quitting = false;

/**
 * A cached JPEG of `path` at least `want` px wide (widths round up to a few sizes so each image has
 * at most a handful of copies), or null to serve the original: it's small already, or not a
 * raster format worth shrinking (SVG, GIF), or can't be decoded. Kept in files/.thumbs, which the
 * file pruning clears along with its source.
 */
const THUMB_WIDTHS = [320, 640, 960, 1440, 2048];
function thumbnail(path: string, want: number): string | null {
  if (!/\.(png|jpe?g|webp|bmp)$/i.test(path)) return null;
  const own = path.startsWith(filesDir(sessionId!) + '/');
  const cwd = core.state.session.cwd;
  if (!own && !(cwd && path.startsWith(resolve(cwd) + sep))) return null;
  const width = THUMB_WIDTHS.find((x) => x >= want);
  if (!width) return null;
  const dir = join(filesDir(sessionId!), '.thumbs');
  // Project images: keyed by path and modification time, so an edited image gets a fresh thumbnail.
  const key = own ? basename(path) : `p-${createHash('sha1').update(`${path}:${statSync(path).mtimeMs}`).digest('hex').slice(0, 16)}`;
  const out = join(dir, `${key}@${width}.jpg`);
  if (existsSync(out)) return out;
  const img = nativeImage.createFromPath(path);
  if (img.isEmpty() || img.getSize().width <= width * 1.2) return null;
  mkdirSync(dir, { recursive: true });
  writeFileSync(out, img.resize({ width, quality: 'good' }).toJPEG(85));
  return out;
}

async function boot() {
  lockPermissions();
  attachBuiltinViews(join(__dirname, 'apps'));
  core = new GlassCore(sessionId!, cwd);
  firstPartyCookiesForDeclaredOrigins(); // after mods load: needs their declared origins
  try {
    await core.listen();
  } catch (e: any) {
    console.error(e.message);
    app.exit(0);
    return;
  }
  core.onQuit = () => shutdown();
  startMetrics(sessionDir(sessionId!), () => ({
    windows: Object.keys(core.state.instances).length, open: core.state.order.length,
    streams: streams.size, pages: webFeeds.size, frames: lastFrames.size,
  }));

  // glass-file://f/<abs path> — only files inside this session's files dir, the configured
  // background, or images inside the project folder (the Images app's "Project" list).
  protocol.handle('glass-file', (req) => {
    const url = new URL(req.url);
    const path = resolve(decodeURIComponent(url.pathname));
    const cwd = core.state.session.cwd;
    const allowed = path.startsWith(filesDir(sessionId!) + '/') || path === core.config.background
      || (!!cwd && path.startsWith(resolve(cwd) + sep) && IMAGE_FILE.test(path));
    if (!allowed) return new Response('forbidden', { status: 403 });
    try {
      // ?w=<px>: a downsized copy for views that show the image small (cached in files/.thumbs).
      const w = Number(url.searchParams.get('w'));
      const thumb = w > 0 ? thumbnail(path, w) : null;
      if (thumb) return new Response(readFileSync(thumb), { headers: { 'content-type': 'image/jpeg' } });
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
    if (url.hostname === 'sdk' && /\.woff2$/.test(path)) headers['access-control-allow-origin'] = '*'; // the bundled fonts, for sandboxed frames
    if (type.startsWith('text/html')) headers['content-security-policy'] = appCsp(APPS[url.hostname]?.permissions ?? NO_PERMISSIONS);
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
  // Settings → "Reset data": forget what an app and the pages it embeds stored (storage + cookies).
  // The markdown viewer following a link to another markdown file: any local markdown/text file
  // the user can read (only those, so it stays a viewer). macOS may ask once before the glass reads
  // from protected folders (Documents, Desktop, Downloads, iCloud Drive).
  // The Images app's "Project" list: images in the project folder, newest first.
  ipcMain.handle('glass:projectImages', () => ({ ok: true, result: { root: core.state.session.cwd, images: findProjectImages(core.state.session.cwd) } }));
  ipcMain.handle('glass:readDoc', (_e, _id: string, path: string) => {
    try {
      const target = resolve(String(path));
      if (!/\.(md|markdown|mdx|txt)$/i.test(target)) throw new Error('only markdown files open here');
      if (statSync(target).size > 2_000_000) throw new Error('too large');
      return { ok: true, result: { path: target, text: readFileSync(target, 'utf8') } };
    } catch (e: any) {
      return { ok: false, error: e.code === 'ENOENT' ? 'file not found' : e.message };
    }
  });
  // Web links in app views open in the user's browser (the frames themselves can't navigate).
  ipcMain.on('glass:openLink', (_e, url: string) => {
    if (/^(https?:|mailto:)/i.test(String(url))) void shell.openExternal(String(url));
  });
  // Show an image in Finder/Explorer: the first of the given paths that still exists (the original,
  // then the glass's copy). Only reveals; never opens or runs anything.
  ipcMain.on('glass:revealFile', (_e, paths: unknown) => {
    const p = (Array.isArray(paths) ? paths : []).find((x) => typeof x === 'string' && isAbsolute(x) && existsSync(x));
    if (p) shell.showItemInFolder(p);
  });
  ipcMain.handle('glass:preset',(_e, action: string, name?: string, description?: string) => core.handle({ op: 'preset', action, name, description }));
  ipcMain.handle('glass:resetAppData', async (_e, type: string) => {
    const p = APPS[type]?.permissions;
    if (!p) return false;
    const ses = session.defaultSession;
    const origins = [`glass-app://${type}`, ...p.network.filter((o) => o.startsWith('http'))];
    for (const origin of origins) {
      await ses.clearStorageData({ origin }).catch(() => {});
      for (const c of await ses.cookies.get({ url: origin }).catch(() => [])) await ses.cookies.remove(origin, c.name).catch(() => {});
    }
    // Embedded pages keep storage in a partition keyed to the glass, which clearStorageData by
    // origin doesn't reach: clear it from inside their live frames too.
    for (const f of win && !win.isDestroyed() ? win.webContents.mainFrame.framesInSubtree : []) {
      if (!origins.some((o) => f.url.startsWith(o))) continue;
      await f.executeJavaScript('try { localStorage.clear(); sessionStorage.clear(); } catch {}').catch(() => {});
    }
    sharedStorage?.forget(origins); // and the copy other glasses would restore
    return true;
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
  watchForUpdate();
  // Embedded pages' sign-ins follow you to every glass, for apps that opt in (permissions.sharedSignIn):
  // saved each minute and on close.
  const webOrigins = () => [...new Set(Object.values(APPS).filter((a) => a.permissions?.sharedSignIn).flatMap((a) => a.permissions!.network).filter((o) => /^https?:/.test(o)))];
  sharedStorage = shareAppStorage(win!, join(glassHome(), 'app-storage.json'), webOrigins);
  setInterval(() => void sharedStorage?.save(), 60_000).unref();
}
let sharedStorage: ReturnType<typeof shareAppStorage> | null = null;

// Updates: a glass running from an older plugin install offers to restart in the new version (a
// pill in the top bar), and restarts on its own if the update removed its folder. It changes only
// the glass itself; nothing reaches Claude.
const ownRoot = resolve(__dirname, '..');
ipcMain.handle('glass:version', () => ownVersion(ownRoot)); // before the window asks for it
let update: Installed | null = null;
let relaunching = false;
function watchForUpdate() {
  const check = () => {
    const u = pendingUpdate(ownRoot);
    if (u?.root !== update?.root) { update = u; win?.webContents.send('glass:update', u); }
    if (u && !existsSync(join(ownRoot, 'package.json'))) relaunchInto(u); // our files are gone
  };
  check();
  setInterval(check, 30_000).unref();
  ipcMain.handle('glass:getUpdate', () => update);
  ipcMain.on('glass:applyUpdate', () => { if (update) relaunchInto(update); });
}
/** Hand off to the new version: its CLI waits for this process to exit, then opens this glass again. */
function relaunchInto(u: Installed) {
  if (relaunching) return;
  relaunching = true;
  // Run the new CLI with this Electron as Node; launchd's PATH may lack node/npm for a first-run build.
  const PATH = [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].filter(Boolean).join(':');
  spawn(process.execPath, [join(u.root, 'bin', 'claude-glass'), 'relaunch', '--glass', sessionId!, '--cwd', core.state.session.cwd || cwd, '--after', String(process.pid)],
    { detached: true, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PATH } }).unref();
  void shutdown();
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
  // Forget frames of browser windows that are gone (history mode deletes them all the time).
  for (const id of lastFrames.keys()) if (!s.instances[id]) lastFrames.delete(id);
  for (const id of lastHomeSeq.keys()) if (!s.instances[id]) lastHomeSeq.delete(id);
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
  // Fullscreen hides the traffic lights; the renderer drops their inset from the top bar.
  win.on('enter-full-screen', () => win?.webContents.send('glass:fullscreen', true));
  win.on('leave-full-screen', () => win?.webContents.send('glass:fullscreen', false));
}

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Claude Glass', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { type: 'separator' }, { label: 'Close Claude Glass', accelerator: 'CmdOrCtrl+Q', click: () => shutdown() }] },
    // The full set: on macOS these menu roles are what make ⌘Z/⌘X/⌘V work in any text field
    // (app views with their own forms, Settings). They only ever act on the focused field.
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'pasteAndMatchStyle' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { label: 'Window', submenu: [{ role: 'minimize' }, { label: 'Close', accelerator: 'CmdOrCtrl+W', click: () => shutdown() }] },
  ]));
}

async function shutdown() {
  if (quitting) return;
  quitting = true;
  try { await Promise.race([sharedStorage?.save(), new Promise((r) => setTimeout(r, 800))]); } catch {} // sign-ins, for the next glass
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
