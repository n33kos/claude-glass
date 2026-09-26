import { type AppDef, type Args, str, unknownCommand } from '../types';

// The browser Claude uses, shown live. Three sources; the latest activity decides what's on screen:
//  - cdp: a Chrome DevTools Protocol endpoint (Playwright/Puppeteer/Chrome with
//    --remote-debugging-port). Electron main screencasts the active page; frames go straight to
//    the renderer (a video feed, not state). Only status/url/title land here.
//  - shot: any tool that can save a screenshot (Firefox, WebKit, Selenium...) pushes frames with
//    `frame --file`. Only the latest one is kept.
//  - web: Claude's WebSearch/WebFetch, filled by hooks. Search results render as a list; fetched
//    pages load in a hidden, sandboxed Electron window whose frames stream in like cdp.
// One-way: the glass watches, it never clicks or types into a page Claude is using.

export interface WebResult { title: string; url: string }
export type WebActivity =
  | { kind: 'search'; query: string; results: WebResult[] | null; at: number } // null = still searching
  | { kind: 'page'; url: string; title?: string; at: number };

export interface BrowserState {
  view: 'off' | 'cdp' | 'shot' | 'web';
  endpoint: string | null;
  status: 'off' | 'waiting' | 'live'; // cdp connection
  url?: string; // cdp page
  title?: string;
  shot?: { file: string; url?: string; title?: string; at: number };
  web?: WebActivity;
  updatedAt: number;
}

export const DEFAULT_CDP = 'http://127.0.0.1:9222';
const MAX_RESULTS = 20;

/** Accept a port, host:port or http(s) URL, but only on this machine. */
export function normalizeEndpoint(raw: string): string {
  const s = raw.trim();
  const url = new URL(/^\d+$/.test(s) ? `http://127.0.0.1:${s}` : /^[a-z]+:\/\//i.test(s) ? s : `http://${s}`);
  if (url.protocol === 'ws:' || url.protocol === 'wss:') url.protocol = url.protocol === 'ws:' ? 'http:' : 'https:';
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error(`browser: endpoint must be on this machine (got ${url.hostname})`);
  return `${url.protocol}//${url.host}`;
}

/** WebSearch tool_response.results mixes {content: [{title, url}]} blocks with summary strings. */
export function searchResults(response: any): WebResult[] {
  const out: WebResult[] = [];
  for (const r of Array.isArray(response?.results) ? response.results : []) {
    for (const c of Array.isArray(r?.content) ? r.content : []) {
      if (c?.url && /^https?:\/\//.test(String(c.url))) out.push({ title: String(c.title || c.url), url: String(c.url) });
    }
  }
  return out.slice(0, MAX_RESULTS);
}

export const browser: AppDef<BrowserState> = {
  type: 'browser',
  title: 'Browser',
  icon: '◎',
  singleton: true,
  description: 'The browser you use, live. Web searches and fetched pages show up automatically. `attach` screencasts any Chromium with a DevTools port (Playwright, Puppeteer, Chrome --remote-debugging-port=9222) and follows its most recently active tab; run it headless. For other browsers, push screenshots with `frame --file`.',
  commands: {
    attach: { usage: `attach [--cdp <port|url>]`, help: `Stream a Chromium DevTools endpoint (default ${DEFAULT_CDP})` },
    frame: { usage: 'frame --file <png|jpg> [--url U] [--title T]', help: 'Show a screenshot (for browsers without CDP)' },
    detach: { usage: 'detach', help: 'Stop streaming' },
  },
  init: () => ({ view: 'off', endpoint: null, status: 'off', updatedAt: 0 }),
  command(s, cmd, a: Args) {
    const now = Date.now();
    switch (cmd) {
      case 'attach': {
        const endpoint = normalizeEndpoint(a.cdp === undefined || a.cdp === true ? DEFAULT_CDP : String(a.cdp));
        return { ...s, view: 'cdp', endpoint, status: 'waiting', url: undefined, title: undefined, updatedAt: now };
      }
      case 'frame':
        return { ...s, view: 'shot', shot: { file: str(a, 'file'), url: a.url ? String(a.url) : undefined, title: a.title ? String(a.title) : undefined, at: now }, updatedAt: now };
      case 'detach':
        return { ...s, view: s.view === 'cdp' ? 'off' : s.view, endpoint: null, status: 'off', updatedAt: now };
      case 'status': {
        // Internal: reported by the cdp stream in Electron main. A navigation there (new url or
        // title) is fresh activity, so it takes the screen back from web/shot.
        if (!s.endpoint) return s;
        const status = a.status === 'live' ? 'live' : 'waiting';
        const url = a.url ? String(a.url) : undefined, title = a.title ? String(a.title) : undefined;
        if (s.status === status && s.url === url && s.title === title) return s;
        const navigated = status === 'live' && (url !== s.url || title !== s.title);
        return { ...s, status, url, title, view: navigated ? 'cdp' : s.view, updatedAt: now };
      }
      case 'web.search': {
        // Internal (hooks). Without results: searching. With results: done.
        const query = str(a, 'query');
        return { ...s, view: 'web', web: { kind: 'search', query, results: Array.isArray(a.results) ? (a.results as WebResult[]).slice(0, MAX_RESULTS) : null, at: now }, updatedAt: now };
      }
      case 'web.page': {
        const url = str(a, 'url');
        if (!/^https?:\/\//i.test(url)) return s;
        if (s.web?.kind === 'page' && s.web.url === url) return s.view === 'web' ? s : { ...s, view: 'web', updatedAt: now };
        return { ...s, view: 'web', web: { kind: 'page', url, at: now }, updatedAt: now };
      }
      case 'web.title': {
        if (s.web?.kind !== 'page' || s.web.url !== a.url || s.web.title === a.title) return s;
        return { ...s, web: { ...s.web, title: String(a.title ?? '') } };
      }
      default:
        return unknownCommand('browser', cmd);
    }
  },
};
