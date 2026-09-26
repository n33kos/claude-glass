// Screencast of a Chromium DevTools endpoint. Plain Node (fetch + WebSocket), no Electron.
// Watches only: Page.startScreencast + frame acks. It never sends input to the page.

export interface StreamStatus { status: 'live' | 'waiting'; url?: string; title?: string }
export interface StreamEvents {
  frame(jpegBase64: string): void;
  status(s: StreamStatus): void;
}

interface Target { id: string; type: string; url: string; title: string; webSocketDebuggerUrl?: string }

const POLL_MS = 1000;
const MIN_FRAME_MS = 66; // ~15 fps is plenty for watching

export class BrowserStream {
  private ws: WebSocket | null = null;
  private targetId: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private last = '';
  private lastFrameAt = 0;
  private stopped = false;

  constructor(readonly endpoint: string, private ev: StreamEvents) {}

  start() {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), POLL_MS);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.close();
  }

  private report(s: StreamStatus) {
    const key = JSON.stringify(s);
    if (key === this.last || this.stopped) return;
    this.last = key;
    this.ev.status(s);
  }

  private close() {
    const ws = this.ws;
    this.ws = null;
    this.targetId = null;
    try { ws?.close(); } catch {}
  }

  private async tick() {
    let targets: Target[];
    try {
      const r = await fetch(`${this.endpoint}/json/list`, { signal: AbortSignal.timeout(800) });
      targets = await r.json() as Target[];
    } catch {
      this.close();
      return this.report({ status: 'waiting' });
    }
    if (this.stopped) return;
    // Chrome lists pages most recently active first, so [0] is the tab being driven.
    const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && !t.url.startsWith('devtools://'));
    if (!page) {
      this.close();
      return this.report({ status: 'waiting' });
    }
    if (page.id !== this.targetId || !this.ws) this.connect(page);
    this.report({ status: 'live', url: page.url, title: page.title });
  }

  private connect(page: Target) {
    this.close();
    this.targetId = page.id;
    const ws = new WebSocket(page.webSocketDebuggerUrl!);
    this.ws = ws;
    let seq = 0;
    const send = (method: string, params: object = {}) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ id: ++seq, method, params }));
    ws.onopen = () => send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: 1600, maxHeight: 1200 });
    ws.onmessage = (e) => {
      let msg: any;
      try { msg = JSON.parse(String(e.data)); } catch { return; }
      if (msg.method !== 'Page.screencastFrame' || this.ws !== ws) return;
      this.ev.frame(msg.params.data);
      // Acking asks Chrome for the next frame; delaying it caps the frame rate.
      const wait = Math.max(0, MIN_FRAME_MS - (Date.now() - this.lastFrameAt));
      this.lastFrameAt = Date.now() + wait;
      setTimeout(() => send('Page.screencastFrameAck', { sessionId: msg.params.sessionId }), wait);
    };
    const drop = () => { if (this.ws === ws) { this.ws = null; this.targetId = null; } };
    ws.onclose = drop;
    ws.onerror = drop;
  }
}
