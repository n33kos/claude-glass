// The signal layer (docs/design.md): Graphite Mono's chrome has no color, so the wallpaper light is
// where color speaks. A small vocabulary, one signal at a time, each decaying back to graphite:
//   waiting on you   amber rises from the bottom edge and breathes          (automatic: hooks)
//   alert            red flickers behind the window that broke               (Claude, or a failing test run: followTests)
//   spotlight        blue gathers behind one window, its edge lights         (Claude: "look here", or the follow* settings)
//   done             one green bloom, after a turn long enough to look away  (automatic: the turn's end)
//   progress         a pale light at the front of a hairline bar             (Claude: long work, known end)
// Priority, highest first: waiting, alert, spotlight, done, progress (it resumes when the others end).
// A glow sits behind the windows (between wallpaper and stage); a ring over the target window.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { GlassState } from '../core/types';

const SHOW_MS = { spotlight: 5200, alert: 4600, done: 3600 } as const;
const DONE_AFTER_MS = 30_000; // only turns this long get a done bloom: short ones you watched anyway
const PROGRESS_STALE_MS = 15 * 60_000; // progress Claude stopped updating fades out

type Active =
  | { kind: 'wait' }
  | { kind: 'alert' | 'spotlight'; target?: string; key: string }
  | { kind: 'done'; key: string }
  | { kind: 'progress'; value: number; label?: string };

interface Local { kind: 'alert' | 'done'; target?: string; at: number }

/**
 * The turn bar: a thin white line along the bottom while Claude works on a turn (turnProgress).
 * A turn has no known end, so it sweeps; each new model request (a step) brightens it once. While
 * Claude works through a task list it fills instead, by tasks done. It pauses while Claude waits on you.
 */
export function TurnBar({ state }: { state: GlassState }) {
  const s = state.session;
  if (s.activity !== 'working' || s.endedAt || !s.turn) return null;
  const items = (state.appState.tasks as { items?: { status: string }[] } | undefined)?.items ?? [];
  const done = items.filter((t) => t.status === 'completed').length;
  const tasking = items.length > 1 && done < items.length && items.some((t) => t.status !== 'pending');
  const pct = tasking ? Math.round((done / items.length) * 100) : undefined;
  return (
    <div className={`turn-bar${pct == null ? ' sweep' : ''}${s.waiting ? ' paused' : ''}`} aria-hidden>
      {pct != null && <i className="fill" style={{ width: `${Math.max(pct, 2)}%` }} />}
      <b key={s.turn.steps} className="pulse" />
    </div>
  );
}

export function SignalLayer({ state, on, done = true }: { state: GlassState; on: boolean; done?: boolean }) {
  const [, tick] = useState(0);
  const local = useRef<Local[]>([]);
  // How the last turn really ended (the mod's turn.complete): a long one answered gets the done
  // bloom; one that died on an error or a refusal lights the conversation red.
  const last = state.session.lastTurn;
  const seenTurn = useRef(last?.id);
  useEffect(() => {
    if (!last || last.id === seenTurn.current) return;
    seenTurn.current = last.id;
    if (Date.now() - last.at > 10_000 || state.session.endedAt) return; // an old one, from a reload
    if (last.reason === 'error' || last.reason === 'refusal') push({ kind: 'alert', target: 'conversation', at: Date.now() });
    else if (done && last.reason === 'answer' && last.durationMs >= DONE_AFTER_MS) push({ kind: 'done', at: Date.now() });
  }, [last?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // (A failed test run is lit by the core, by the followTests setting: src/core/events.ts.)
  // Settings' preview buttons play the automatic ones here (they never go through Claude).
  useEffect(() => {
    const on = (e: Event) => { const kind = (e as CustomEvent<'done' | 'alert'>).detail; push({ kind, at: Date.now(), ...(kind === 'alert' ? { target: 'settings' } : {}) }); };
    window.addEventListener('glass:preview-signal', on);
    return () => window.removeEventListener('glass:preview-signal', on);
  }, []);
  function push(e: Local) {
    local.current = [...local.current.filter((x) => Date.now() - x.at < 10_000), e];
    tick((t) => t + 1);
    setTimeout(() => tick((t) => t + 1), SHOW_MS[e.kind] + 50);
  }
  // Claude's own signal: re-render when a transient one ends.
  const sig = state.signal;
  useEffect(() => {
    if (!sig || sig.kind === 'progress') return;
    const left = sig.at + SHOW_MS[sig.kind] - Date.now();
    if (left > 0) { const t = setTimeout(() => tick((x) => x + 1), left + 50); return () => clearTimeout(t); }
  }, [sig?.seq]); // eslint-disable-line react-hooks/exhaustive-deps

  const now = Date.now();
  const live = <K extends keyof typeof SHOW_MS>(kind: K, at: number) => now - at < SHOW_MS[kind];
  const waiting = !!state.session.waiting && !state.session.endedAt;
  const alertL = [...local.current].reverse().find((e) => e.kind === 'alert' && live('alert', e.at));
  const doneL = [...local.current].reverse().find((e) => e.kind === 'done' && live('done', e.at));
  const active: Active | null = !on ? null
    : waiting ? { kind: 'wait' }
    : sig?.kind === 'alert' && live('alert', sig.at) ? { kind: 'alert', target: sig.target, key: `c${sig.seq}` }
    : alertL ? { kind: 'alert', target: alertL.target, key: `l${alertL.at}` }
    : sig?.kind === 'spotlight' && live('spotlight', sig.at) ? { kind: 'spotlight', target: sig.target, key: `c${sig.seq}` }
    : doneL ? { kind: 'done', key: `d${doneL.at}` }
    : sig?.kind === 'progress' && now - sig.at < PROGRESS_STALE_MS ? { kind: 'progress', value: sig.value ?? 0, label: sig.label }
    : null;

  // Follow the target window while its signal plays (it may move or resize).
  const glow = useRef<HTMLDivElement>(null);
  const ring = useRef<HTMLDivElement>(null);
  const target = active && 'target' in active ? active.target : undefined;
  const [found, setFound] = useState(true);
  useLayoutEffect(() => {
    if (!target) return;
    let raf = 0, stop = false;
    const follow = () => {
      if (stop) return;
      const el = document.querySelector<HTMLElement>(`.stage [data-window="${CSS.escape(target)}"]`);
      const root = document.querySelector('.glass')?.getBoundingClientRect();
      const r = el?.getBoundingClientRect();
      const visible = !!(r && root && r.width > 0 && r.right > root.left && r.left < root.right && getComputedStyle(el!).visibility !== 'hidden');
      setFound(visible);
      if (visible && r && root) {
        const x = r.left - root.left, y = r.top - root.top;
        if (glow.current) Object.assign(glow.current.style, { left: `${x - r.width * 0.15}px`, top: `${y - r.height * 0.15}px`, width: `${r.width * 1.3}px`, height: `${r.height * 1.3}px` });
        if (ring.current) Object.assign(ring.current.style, { left: `${x}px`, top: `${y}px`, width: `${r.width}px`, height: `${r.height}px` });
      }
      raf = requestAnimationFrame(follow);
    };
    follow();
    return () => { stop = true; cancelAnimationFrame(raf); };
  }, [target, active && 'key' in active ? active.key : '']); // eslint-disable-line react-hooks/exhaustive-deps

  if (!active) return null;
  if (active.kind === 'wait') return <div className="sig-glow sig-wait" aria-hidden />;
  if (active.kind === 'done') return <div key={active.key} className="sig-glow sig-done" aria-hidden />;
  if (active.kind === 'progress') {
    const pct = Math.round(active.value * 100);
    return (
      <>
        <div className="sig-glow sig-progress" style={{ left: `calc(${pct}% - 20%)` }} aria-hidden />
        <div className="sig-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={active.label ?? 'Progress'}>
          <i style={{ width: `${pct}%` }} />
          {active.label && <span>{active.label} · {pct}%</span>}
        </div>
      </>
    );
  }
  // Alert / spotlight: behind the window if it's on screen, else a general wash from the bottom.
  return (
    <>
      <div key={`g${active.key}`} ref={glow} className={`sig-glow sig-${active.kind}${target && found ? ' at' : ' wash'}`} aria-hidden />
      {target && found && <div key={`r${active.key}`} ref={ring} className={`sig-ring sig-${active.kind}`} aria-hidden />}
    </>
  );
}
