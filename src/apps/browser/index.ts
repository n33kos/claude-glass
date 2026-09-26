import { type AppDef, type Args, str, unknownCommand } from '../types';

// The browser Claude drives, shown live. Two sources:
//  - live: a Chrome DevTools Protocol endpoint (Playwright/Puppeteer/Chrome with
//    --remote-debugging-port). Electron main screencasts the active page; frames go straight to
//    the renderer (a video feed, not state). Only status/url/title land here.
//  - pushed: any tool that can save a screenshot (Firefox, WebKit, Selenium...) sends frames with
//    `frame --file`. Only the latest one is kept.
// One-way: the glass watches the browser, it never clicks or types.

export interface BrowserState {
  endpoint: string | null;
  status: 'off' | 'waiting' | 'live' | 'pushed';
  url?: string;
  title?: string;
  frame?: string; // latest pushed screenshot (files dir path)
  updatedAt: number;
}

export const DEFAULT_CDP = 'http://127.0.0.1:9222';

/** Accept a port, host:port or http(s) URL, but only on this machine. */
export function normalizeEndpoint(raw: string): string {
  const s = raw.trim();
  const url = new URL(/^\d+$/.test(s) ? `http://127.0.0.1:${s}` : /^[a-z]+:\/\//i.test(s) ? s : `http://${s}`);
  if (url.protocol === 'ws:' || url.protocol === 'wss:') url.protocol = url.protocol === 'ws:' ? 'http:' : 'https:';
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error(`browser: endpoint must be on this machine (got ${url.hostname})`);
  return `${url.protocol}//${url.host}`;
}

export const browser: AppDef<BrowserState> = {
  type: 'browser',
  title: 'Browser',
  icon: '◎',
  singleton: true,
  description: 'Live view of the browser you drive. `attach` screencasts any Chromium with a DevTools port (Playwright, Puppeteer, Chrome --remote-debugging-port=9222); it follows the most recently active tab. For other browsers, push screenshots with `frame --file`.',
  commands: {
    attach: { usage: `attach [--cdp <port|url>]`, help: `Stream a Chromium DevTools endpoint (default ${DEFAULT_CDP})` },
    frame: { usage: 'frame --file <png|jpg> [--url U] [--title T]', help: 'Show a screenshot (for browsers without CDP)' },
    detach: { usage: 'detach', help: 'Stop streaming' },
  },
  init: () => ({ endpoint: null, status: 'off', updatedAt: 0 }),
  command(s, cmd, a: Args) {
    switch (cmd) {
      case 'attach': {
        const endpoint = normalizeEndpoint(a.cdp === undefined || a.cdp === true ? DEFAULT_CDP : String(a.cdp));
        return { endpoint, status: 'waiting', updatedAt: Date.now() };
      }
      case 'frame':
        return {
          endpoint: null, status: 'pushed', frame: str(a, 'file'),
          url: a.url ? String(a.url) : undefined, title: a.title ? String(a.title) : undefined, updatedAt: Date.now(),
        };
      case 'detach':
        return { ...s, endpoint: null, status: 'off', updatedAt: Date.now() };
      case 'status': {
        // Internal: reported by the stream in Electron main.
        if (!s.endpoint) return s;
        const status = a.status === 'live' ? 'live' : 'waiting';
        const url = a.url ? String(a.url) : undefined, title = a.title ? String(a.title) : undefined;
        if (s.status === status && s.url === url && s.title === title) return s;
        return { ...s, status, url, title, updatedAt: Date.now() };
      }
      default:
        return unknownCommand('browser', cmd);
    }
  },
};
