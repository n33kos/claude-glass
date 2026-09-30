// The signal layer (docs/design.md): Graphite Mono's chrome has no color, so the wallpaper light is
// where color speaks. A small vocabulary, one signal at a time, each decaying back to graphite:
//   waiting on you   amber rises from the bottom edge and breathes          (automatic: hooks)
//   alert            red flickers behind the window that broke               (Claude, or a failing test run)
//   spotlight        blue gathers behind one window, its edge lights         (Claude: "look here")
//   done             one green bloom, after a turn long enough to look away  (automatic: Stop)
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

export function SignalLayer({ state, on, done = true, failed = true }: { state: GlassState; on: boolean; done?: boolean; failed?: boolean }) {
  const [, tick] = useState(0);
  const local = useRef<Local[]>([]);
  // Done: the session went idle after a long enough turn.
  const workingSince = useRef<number | null>(null);
  useEffect(() => {
    if (state.session.activity === 'working') { workingSince.current ??= Date.now(); return; }
    const since = workingSince.current;
    workingSince.current = null;
    if (done && since && Date.now() - since >= DONE_AFTER_MS && !state.session.endedAt) push({ kind: 'done', at: Date.now() });
  }, [state.session.activity]); // eslint-disable-line react-hooks/exhaustive-deps
  // Failed: a new test run that failed flags the Tests window.
  const runs = (state.appState.tests as { runs?: { ok: boolean }[] } | undefined)?.runs;
  const seenRuns = useRef(runs?.length ?? 0);
  useEffect(() => {
    const n = runs?.length ?? 0;
    if (failed && n > seenRuns.current && runs?.[n - 1] && !runs[n - 1].ok) push({ kind: 'alert', target: 'tests', at: Date.now() });
    seenRuns.current = n;
  }, [runs]); // eslint-disable-line react-hooks/exhaustive-deps
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
