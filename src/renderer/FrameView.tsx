// Hosts an app view in a sandboxed frame (glass-app://<type>/view.html) and speaks the SDK's
// bridge v1 (src/sdk/glass-app.ts). The frame gets props; it can run its own view commands and
// ask for host services. It can't reach Claude, other apps, or the shell's DOM.
import { useEffect, useMemo, useRef, useState } from 'react';
import { settingValues, type AppInfo } from '../apps/types';
import type { GlassState, InstanceMeta } from '../core/types';
import { Lightbox } from './Lightbox';

interface Props {
  app: AppInfo;
  id: string;
  meta: InstanceMeta;
  state: unknown;
  width: number;
  height: number;
  glass: GlassState;
  run: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  stored?: Record<string, unknown>; // this app's saved settings (config.appSettings[type])
}

export function FrameView({ app, id, meta, state, width, height, glass, run, stored }: Props) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);

  const session = { cwd: glass.session.cwd, activity: glass.session.activity, ended: !!glass.session.endedAt, waiting: glass.session.waiting ?? null };
  const settings = useMemo(() => settingValues(app, stored), [app, stored]);
  const props = { id, meta: { id, type: meta.type, title: meta.title }, state, size: { width, height }, session, settings };
  const post = (msg: object) => ref.current?.contentWindow?.postMessage({ glass: 1, ...msg }, '*');
  const latest = useRef(props);
  latest.current = props;

  // Messages from this frame only.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== ref.current?.contentWindow) return;
      const m = e.data;
      if (!m || m.glass !== 1) return;
      // A frame reloads whenever it moves in the DOM (window reorder): always answer 'ready'.
      if (m.kind === 'ready') {
        setReady(true);
        post({ kind: 'props', props: latest.current });
        window.glass.lastFrame(id).then((f) => { if (f) for (const [source, data] of Object.entries(f)) if (data) post({ kind: 'frame', source, data }); });
      }
      else if (m.kind === 'run' && typeof m.command === 'string') {
        if (app.viewCommands.includes(m.command)) void run(m.command, m.args && typeof m.args === 'object' ? m.args : {});
        else console.warn(`app ${app.type}: view may not run "${m.command}" (not a view command)`);
      } else if (m.kind === 'host') hostService(m.service, m.args ?? {});
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  });

  function hostService(service: string, args: Record<string, unknown>) {
    if (service === 'lightbox' && typeof args.src === 'string') setLightbox({ src: args.src, alt: String(args.alt ?? '') });
    else if (service === 'aspect' && typeof args.value === 'number') window.glass.webAspect(args.value);
    else if (service === 'page-input' && app.type === 'browser') window.glass.webInput({ ...args, id });
  }

  // Props on ready and on every change (state slices keep identity when unchanged).
  useEffect(() => { if (ready) post({ kind: 'props', props }); },
    [ready, state, width, height, meta.title, session.cwd, session.activity, session.waiting, session.ended, settings]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live frames for this instance (browser stream); the latest ones are replayed on 'ready'.
  useEffect(() => window.glass.onFrame((f) => { if (f.id === id) post({ kind: 'frame', source: f.source, data: f.data }); }), [id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      {/* Sandboxed (forms allowed: submit handlers are normal UI); an app that asked for storage gets its own origin (glass-app://<type>), and one
          that asked for the microphone gets it via Permissions Policy (main grants it per app). */}
      <iframe ref={ref} className="appframe" src={`glass-app://${app.type}/view.html`} title={meta.title}
        sandbox={app.permissions.storage ? 'allow-scripts allow-forms allow-same-origin' : 'allow-scripts allow-forms'}
        allow={app.permissions.microphone ? ["microphone 'src'", ...app.permissions.network.filter((o) => o.startsWith('http'))].join(' ') : undefined} />
      {lightbox && <Lightbox {...lightbox} onClose={() => setLightbox(null)} />}
    </>
  );
}
