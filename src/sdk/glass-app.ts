// Claude Glass app SDK (bridge v1). A view loads it with:
//   <link rel="stylesheet" href="glass-app://sdk/glass-app.css">
//   <script src="glass-app://sdk/glass-app.js"></script>
// Then: glass.onState(({ state, meta, size, session }) => render(...))
//       glass.run('select', { index: 2 })   // only commands the manifest marks as view commands
//       glass.host('lightbox', { src })      // host services
// The view is a sandboxed frame: it talks to the glass only through these messages.

export interface GlassProps<S = any> {
  id: string;
  meta: { id: string; type: string; title: string };
  state: S;
  size: { width: number; height: number };
  session: {
    cwd: string;
    activity: 'idle' | 'working';
    ended: boolean;
    waiting: { kind: 'question' | 'permission'; summary: string; tool?: string; toolUseId?: string } | null;
  };
}

type Listener = (p: GlassProps) => void;
type FrameListener = (f: { source: string; data: string }) => void;

const listeners = new Set<Listener>();
const frameListeners = new Set<FrameListener>();
let props: GlassProps | null = null;

const post = (msg: object) => window.parent.postMessage({ glass: 1, ...msg }, '*');

window.addEventListener('message', (e) => {
  if (e.source !== window.parent) return;
  const m = e.data;
  if (!m || m.glass !== 1) return;
  if (m.kind === 'props') {
    props = m.props as GlassProps;
    for (const fn of listeners) fn(props);
  } else if (m.kind === 'frame') {
    for (const fn of frameListeners) fn({ source: m.source, data: m.data });
  }
});

const glass = {
  version: 1,
  /** Called with the latest props now (if any) and on every change. Returns an unsubscribe. */
  onState(fn: Listener): () => void {
    listeners.add(fn);
    if (props) fn(props);
    return () => listeners.delete(fn);
  },
  get props(): GlassProps | null { return props; },
  /** Run one of this app's view commands (view-only changes; never reaches Claude). */
  run(command: string, args: Record<string, unknown> = {}): void { post({ kind: 'run', command, args }); },
  /** Ask the glass for a host service: 'lightbox' { src, alt } | 'aspect' { value }. */
  host(service: string, args: Record<string, unknown> = {}): void { post({ kind: 'host', service, args }); },
  /** Live frames some apps receive from the host (e.g. the browser stream). */
  onFrame(fn: FrameListener): () => void {
    frameListeners.add(fn);
    return () => frameListeners.delete(fn);
  },
};

(window as any).glass = glass;
export default glass;

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => post({ kind: 'ready' }));
else post({ kind: 'ready' });
