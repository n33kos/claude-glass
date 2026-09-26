// Renders the page Claude is reading (WebFetch) in a hidden, offscreen Electron window and hands
// its paints to the glass as JPEG frames. Watch-only: no preload, no Node, sandboxed, throwaway
// in-memory session, no popups/downloads/permissions, muted. The user sees pictures of the page.
import { BrowserWindow, session } from 'electron';

// Narrower than a desktop browser so text stays readable when the tile scales it down.
const WIDTH = 1024, HEIGHT = 720, FPS = 8;

export class WebFeed {
  private win: BrowserWindow | null = null;
  private url: string | null = null;

  constructor(private onFrame: (jpegBase64: string) => void, private onTitle: (url: string, title: string) => void) {}

  private window(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const ses = session.fromPartition('glass-web'); // no "persist:" prefix → in memory only
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    ses.on('will-download', (e) => e.preventDefault());
    const win = new BrowserWindow({
      show: false, width: WIDTH, height: HEIGHT,
      webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, session: ses },
    });
    const wc = win.webContents;
    wc.setAudioMuted(true);
    wc.setFrameRate(FPS);
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('paint', (_e, _dirty, image) => { if (this.url) this.onFrame(image.toJPEG(70).toString('base64')); });
    wc.on('page-title-updated', (_e, title) => { if (this.url) this.onTitle(this.url, title); });
    this.win = win;
    return win;
  }

  show(url: string) {
    if (url === this.url || !/^https?:\/\//i.test(url)) return;
    this.url = url;
    this.window().webContents.loadURL(url).catch(() => {}); // failures still paint Chromium's error page
  }

  /** Throw the page away (its scripts, timers, network) when the web view isn't on screen. */
  hide() {
    this.url = null;
    this.destroy();
  }

  destroy() {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}
