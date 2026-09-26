// Renders the page Claude is reading (WebFetch) in a hidden, offscreen Electron window and hands
// its paints to the glass as JPEG frames. No preload, no Node, sandboxed, throwaway in-memory
// session, no downloads/permissions, muted.
// The user may scroll and click in this copy (a viewing aid: it's the glass's own page, never
// Claude's browser, and nothing goes back to Claude). Claude can highlight a passage on it.
import { BrowserWindow, session } from 'electron';

// Narrower than a desktop browser so text stays readable when the tile scales it down. The
// height follows the tile's shape so the page fills it.
const WIDTH = 1024, FPS = 8;

export interface WebFeedEvents {
  frame(jpegBase64: string): void;
  title(url: string, title: string): void;
  /** The user browsed away from Claude's page (the url they're on), or came back (null). */
  away(url: string | null): void;
  /** Result of a highlight: how many matches were found. */
  found(url: string, matches: number): void;
}

export type WebInput =
  | { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number } // x, y: 0..1 of the page
  | { type: 'click'; x: number; y: number };

const sameDoc = (a: string, b: string) => a.split('#')[0] === b.split('#')[0];

export class WebFeed {
  private win: BrowserWindow | null = null;
  private url: string | null = null; // Claude's page
  private highlight: string | null = null;
  private height = 720;
  private away = false;

  constructor(private ev: WebFeedEvents) {}

  private window(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const ses = session.fromPartition('glass-web'); // no "persist:" prefix → in memory only
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    ses.on('will-download', (e) => e.preventDefault());
    const win = new BrowserWindow({
      show: false, width: WIDTH, height: this.height,
      webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, session: ses },
    });
    const wc = win.webContents;
    wc.setAudioMuted(true);
    wc.setFrameRate(FPS);
    // Links that open new windows navigate this copy instead (still only the glass's page).
    wc.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) wc.loadURL(url).catch(() => {}); return { action: 'deny' }; });
    wc.on('paint', (_e, _dirty, image) => { if (this.url) this.ev.frame(image.toJPEG(70).toString('base64')); });
    wc.on('page-title-updated', (_e, title) => { if (this.url && !this.away) this.ev.title(this.url, title); });
    wc.on('did-navigate', (_e, url) => {
      if (!this.url) return;
      const away = !sameDoc(url, this.url);
      if (away || this.away) this.ev.away(away ? url : null);
      this.away = away;
    });
    wc.on('did-finish-load', () => { if (!this.away) this.find(); });
    this.win = win;
    return win;
  }

  /** Match the tile's aspect ratio (width / height of the area the frame is shown in). */
  fit(aspect: number) {
    if (!(aspect > 0)) return;
    const height = Math.round(Math.min(2400, Math.max(360, WIDTH / aspect)));
    if (Math.abs(height - this.height) < 8) return;
    this.height = height;
    if (this.win && !this.win.isDestroyed()) this.win.setSize(WIDTH, height);
  }

  /** Show Claude's page (reloading it when `home` and the user browsed away), with an optional highlight. */
  show(url: string, highlight: string | null, home = false) {
    if (!/^https?:\/\//i.test(url)) return;
    const reload = url !== this.url || (home && this.away);
    const rehighlight = highlight !== this.highlight;
    this.url = url;
    this.highlight = highlight;
    if (reload) {
      this.away = false;
      this.window().webContents.loadURL(url).catch(() => {}); // failures still paint Chromium's error page
    } else if (rehighlight && !this.away) this.find();
  }

  private idle: ReturnType<typeof setTimeout> | undefined;

  input(e: WebInput) {
    if (!this.url || !this.win || this.win.isDestroyed()) return;
    const wc = this.win.webContents;
    // Smooth while the user interacts, then back to a cheap frame rate.
    wc.setFrameRate(30);
    clearTimeout(this.idle);
    this.idle = setTimeout(() => { if (this.win && !this.win.isDestroyed()) this.win.webContents.setFrameRate(FPS); }, 1200);
    const x = Math.round(Math.max(0, Math.min(1, e.x)) * WIDTH), y = Math.round(Math.max(0, Math.min(1, e.y)) * this.height);
    if (e.type === 'wheel') {
      wc.sendInputEvent({ type: 'mouseWheel', x, y, deltaX: -e.deltaX, deltaY: -e.deltaY, canScroll: true } as Electron.MouseWheelInputEvent);
    } else {
      wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    }
  }

  private find() {
    const wc = this.win && !this.win.isDestroyed() ? this.win.webContents : null;
    const url = this.url;
    if (!wc || !url) return;
    wc.executeJavaScript(`(${highlightInPage.toString()})(${JSON.stringify(this.highlight ?? '')})`)
      .then((n) => { if (this.highlight && this.url === url) this.ev.found(url, Number(n) || 0); })
      .catch(() => {});
  }

  /** Throw the page away (its scripts, timers, network) when the web view isn't on screen. */
  hide() {
    this.url = null;
    this.highlight = null;
    this.away = false;
    this.destroy();
  }

  destroy() {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}

/**
 * Runs inside the glass's copy of the page (serialized with toString; must be self-contained).
 * Finds `q` across text nodes (case- and whitespace-insensitive), marks every match with the CSS
 * Custom Highlight API (no DOM changes), scrolls the first into view. Returns the match count.
 */
function highlightInPage(q: string): number {
  const css = (globalThis as any).CSS;
  css?.highlights?.delete('glass');
  const needle = q.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!needle || !css?.highlights) return 0;
  const map: [Text, number][] = [];
  let text = '';
  let space = true;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const n = walker.currentNode as Text;
    if (!n.parentElement || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(n.parentElement.tagName)) continue;
    for (let i = 0; i < n.data.length; i++) {
      const c = n.data[i];
      if (/\s/.test(c)) { if (space) continue; space = true; text += ' '; } else { space = false; text += c.toLowerCase(); }
      map.push([n, i]);
    }
  }
  const ranges: Range[] = [];
  for (let i = text.indexOf(needle); i !== -1 && ranges.length < 50; i = text.indexOf(needle, i + needle.length)) {
    const r = document.createRange();
    r.setStart(map[i][0], map[i][1]);
    const [en, eo] = map[i + needle.length - 1];
    r.setEnd(en, eo + 1);
    ranges.push(r);
  }
  if (!ranges.length) return 0;
  if (!(document as any).glassHighlightStyle) {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync('::highlight(glass) { background: #fde047; color: #111; }');
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    (document as any).glassHighlightStyle = true;
  }
  css.highlights.set('glass', new (globalThis as any).Highlight(...ranges));
  const top = ranges[0].getBoundingClientRect().top;
  window.scrollTo({ top: window.scrollY + top - window.innerHeight / 3, behavior: 'instant' as ScrollBehavior });
  return ranges.length;
}
