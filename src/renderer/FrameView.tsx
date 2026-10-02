// Hosts an app view in a sandboxed frame (glass-app://<type>/view.html) and speaks the SDK's
// bridge v1 (src/sdk/glass-app.ts). The frame gets props; it can run its own view commands and
// ask for host services. It can't reach Claude, other apps, or the shell's DOM.
import { useEffect, useMemo, useRef, useState } from 'react';
import { settingValues, storedValues, type AppInfo } from '../apps/types';
import { readableShared } from '../core/shared';
import type { GlassState, InstanceMeta } from '../core/types';
import { Lightbox } from './Lightbox';
import { dispatch } from './store';
import { useThemeValue } from './theme';

interface Props {
  app: AppInfo;
  id: string;
  meta: InstanceMeta;
  state: unknown;
  width: number;
  height: number;
  glass: GlassState;
  run: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  savedSettings?: Record<string, unknown>; // this app's saved settings (config.appSettings[type])
}

export function FrameView({ app, id, meta, state, width, height, glass, run, savedSettings }: Props) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);

  const session = { cwd: glass.session.cwd, activity: glass.session.activity, ended: !!glass.session.endedAt, waiting: glass.session.waiting ?? null,
    // Conversation is where the user messages Claude: it sees what goes with the next prompt.
    ...(app.type === 'conversation' ? { attachments: (glass.attachments ?? []).map((a) => ({ id: a.id, label: a.label, text: a.text.slice(0, 600) })) } : {}) };
  const settings = useMemo(() => settingValues(app, savedSettings), [app, savedSettings]);
  // Other apps' public state, for the types this app's manifest may read (permissions.reads).
  const shared = useMemo(() => readableShared(glass, app.permissions.reads), [glass.shared, glass.instances, app]);
  // The app's persistent values (manifest "stored"), defaults filled in.
  const own = glass.stored?.[app.type];
  const stored = useMemo(() => storedValues(app, own), [app, own]);
  const theme = useThemeValue(); // the shell's (theme.ts); the frame sets it on its own page
  const props = { id, meta: { id, type: meta.type, title: meta.title }, state, size: { width, height }, session, settings, stored, shared, theme };
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
      } else if (m.kind === 'store' && m.values && typeof m.values === 'object') {
        // The view writes its own app's persistent values (declared keys only; the reducer checks).
        void dispatch({ type: 'stored.set', app: app.type, values: m.values }).catch((e) => console.warn(`app ${app.type}: ${e?.message ?? e}`));
      } else if (m.kind === 'host') {
        if (typeof m.id === 'number') void answer(m.id, m.service, m.args ?? {});
        else hostService(m.service, m.args ?? {});
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  });

  function hostService(service: string, args: Record<string, unknown>) {
    if (service === 'lightbox' && typeof args.src === 'string') setLightbox({ src: args.src, alt: String(args.alt ?? '') });
    else if (service === 'aspect' && typeof args.value === 'number') window.glass.webAspect(args.value);
    else if (service === 'page-input' && app.type === 'browser') window.glass.webInput({ ...args, id });
    else if (service === 'open-link' && typeof args.url === 'string') window.glass.openLink(args.url);
    else if (service === 'reveal' && app.type === 'image' && Array.isArray(args.paths)) window.glass.revealFile(args.paths.filter((p): p is string => typeof p === 'string'));
    else if (service === 'show-change' && app.type === 'files' && typeof args.path === 'string') showChange(args.path);
    // Point and ask: something from this view goes with the user's next prompt. It reaches Claude,
    // so only built-in apps and two-way ones may offer it (and the user sees it as a chip).
    else if (service === 'attach' && typeof args.text === 'string' && (app.builtin || app.permissions.twoWay)) {
      void dispatch({ type: 'attach.add', label: String(args.label ?? app.title), text: args.text, from: app.type });
    }
    // Conversation's message box, Terminal's command line: sent as the user's prompt (with what's
    // attached), once Claude is free. Only these built-ins; other apps can't speak for the user.
    else if (service === 'prompt' && (app.type === 'conversation' || app.type === 'terminal') && app.builtin && typeof args.text === 'string') window.glass.submitPrompt(args.text, 'conversation');
    else if (service === 'detach' && app.type === 'conversation' && typeof args.id === 'string') void dispatch({ type: 'attach.remove', id: args.id });
  }

  /** Files → Changes: select the file in the Changes window that has it (the live one, else the newest) and bring it into view. */
  function showChange(path: string) {
    const abs = path.startsWith('/') ? path : `${glass.session.cwd.replace(/\/$/, '')}/${path}`;
    const has = (i: InstanceMeta) => i.type === 'diff' && !!(glass.appState[i.id] as { revisions?: Record<string, unknown> } | undefined)?.revisions?.[abs];
    const holders = Object.values(glass.instances).filter(has).sort((a, b) => Number(b.id === 'changes') - Number(a.id === 'changes') || b.createdAt - a.createdAt);
    if (!holders.length) return;
    const target = holders[0].id;
    void dispatch({ type: 'app.command', id: target, command: 'select', args: { path: abs } });
    window.dispatchEvent(new CustomEvent('glass:reveal', { detail: target }));
  }

  // Services that answer. 'read-doc' is the markdown viewer following a link to another markdown
  // file; main reads it (local markdown/text files only). 'project-images': the Images app's list
  // of images in the project folder.
  async function answer(reqId: number, service: string, args: Record<string, unknown>) {
    let reply: { ok: boolean; result?: unknown; error?: string };
    if (service === 'read-doc' && app.type === 'markdown' && typeof args.path === 'string') reply = await window.glass.readDoc(id, args.path);
    else if (service === 'project-images' && app.type === 'image') reply = await window.glass.projectImages();
    else reply = { ok: false, error: `no host service "${service}" for this app` };
    post({ kind: 'reply', id: reqId, ...reply });
  }

  // Props on ready and on every change (state slices keep identity when unchanged).
  useEffect(() => { if (ready) post({ kind: 'props', props }); },
    [ready, state, width, height, meta.title, session.cwd, session.activity, session.waiting, session.ended, settings, stored, shared, app.type === 'conversation' && glass.attachments, theme]); // eslint-disable-line react-hooks/exhaustive-deps

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
