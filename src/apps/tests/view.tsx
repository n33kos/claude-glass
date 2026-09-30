import { useState } from 'react';
import type { AppViewProps } from '../../sdk/react';
import type { TestRun, TestsState } from './index';

const ago = (t: number) => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`; };
const dur = (ms?: number) => (ms == null ? '' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

// Summary: the latest run at a glance (a flask of the recent runs, counts, what's failing, recent runs).
// Details: every run; pick one to see its files, failures and the end of its output.
export default function TestsView({ state, run, width }: AppViewProps<TestsState>) {
  const runs = state.runs;
  const [sel, setSel] = useState<number | null>(null);
  const running = state.running;
  if (!runs.length && running) return (
    <div className="tests">
      <section className="ts-hero run">
        <HistoryFlask runs={runs} running={running} size={112} />
        <div className="ts-hero-text"><div className="ts-verdict">Running…</div><div className="ts-meta"><code>{running.command}</code></div></div>
      </section>
    </div>
  );
  if (!runs.length) return <div className="ts-empty">Test runs Claude does (npm test, vitest, pytest, go test…) show up here as results.</div>;
  const details = state.view === 'details';
  const toggle = <button className="ts-toggle" onClick={() => run('view', { mode: details ? 'summary' : 'details' })}>{details ? 'Summary' : 'Details'}</button>;
  if (!details) return <Summary runs={runs} running={running} toggle={toggle} onPick={(i) => { setSel(i); run('view', { mode: 'details' }); }} />;
  const i = sel != null && sel < runs.length ? sel : runs.length - 1;
  return (
    <div className={`ts-details${width < 640 ? ' narrow' : ''}`}>
      <aside className="ts-runs">
        <div className="ts-runs-head"><b>{runs.length} runs</b>{toggle}</div>
        {[...runs].map((r, j) => ({ r, j })).reverse().map(({ r, j }) => (
          <button key={j} className={`ts-run${j === i ? ' on' : ''} ${r.ok ? 'ok' : 'bad'}`} onClick={() => setSel(j)}>
            <span className="ts-run-dot" />
            <span className="ts-run-main"><b>{r.ok ? 'Passed' : 'Failed'}</b><code>{r.command}</code></span>
            <span className="ts-run-side"><span>{r.passed + r.failed ? `${r.passed}/${r.passed + r.failed}` : '—'}</span><small>{ago(r.at)}</small></span>
          </button>
        ))}
      </aside>
      <RunDetail r={runs[i]} />
    </div>
  );
}

// The flask's inside (viewBox 0 0 80 100): a neck, then a body flaring to a rounded foot.
const FLASK = 'M32 6V38L10 84A7 7 0 0 0 16.5 94H63.5A7 7 0 0 0 70 84L48 38V6Z';
const LIQUID_TOP = 22, LIQUID_BOTTOM = 94; // liquid fills to just below the neck's top

// The flask's inner width at height y (neck 16 wide, then the body widens to 60 at the foot).
const widthAt = (y: number) => (y < 38 ? 16 : y < 84 ? 16 + (44 * (y - 38)) / 46 : 58);
/** The liquid level (y) below which `share` of the liquid's volume lies: splits by volume, not height. */
function levelFor(share: number): number {
  let total = 0;
  for (let y = LIQUID_TOP; y < LIQUID_BOTTOM; y += 0.5) total += widthAt(y);
  let acc = 0;
  for (let y = LIQUID_BOTTOM; y > LIQUID_TOP; y -= 0.5) { acc += widthAt(y - 0.25); if (acc >= total * share) return y - 0.5; }
  return LIQUID_TOP;
}

type Layer = { kind: 'p' | 'f' | 'run'; share: number; title?: string };

/**
 * A flask of liquid, the shape of the Tests icon: layers stack from the bottom. For one run's
 * passed/failed they split the volume (by height, the failed share would hide in the neck); for a
 * stack of runs, the height, so every run is an even band. A rounded glass rim at the mouth; the
 * label sits in the widest part.
 */
function Flask({ layers, size, label, aria, id, even }: { layers: Layer[]; size: number; label: string; aria: string; id: string; even?: boolean }) {
  const total = layers.reduce((t, l) => t + l.share, 0) || 1;
  // `even`: shares split the height (equal bands, for a stack of runs), else the volume.
  const at = (share: number) => (share <= 0 ? LIQUID_BOTTOM : share >= 1 ? LIQUID_TOP : even ? LIQUID_BOTTOM - share * (LIQUID_BOTTOM - LIQUID_TOP) : levelFor(share));
  let below = 0;
  const bands = layers.map((l) => {
    const lo = below / total, hi = (below + l.share) / total;
    below += l.share;
    const bottom = at(lo), top = at(hi);
    return { ...l, y: top, h: Math.max(0, bottom - top) };
  });
  const clip = `flask-${id}`;
  return (
    <svg className="ts-flask" width={size * 0.8} height={size} viewBox="0 0 80 100" role="img" aria-label={aria}>
      <defs><clipPath id={clip}><path d={FLASK} /></clipPath></defs>
      <path d={FLASK} className="glass" />
      <g clipPath={`url(#${clip})`}>
        {/* Each slice reaches a hair into the one below, so no hairline shows between them. */}
        {bands.map((b, i) => <rect key={i} x="0" width="80" className={`liquid ${b.kind}`} style={{ y: b.y, height: b.h + (i === 0 ? 0 : 0.6) }}>{b.title && <title>{b.title}</title>}</rect>)}
        <rect x="0" width="80" height="2" className="meniscus" style={{ y: LIQUID_TOP }} />
        <path d="M31 44L15.5 80" className="shine" />
      </g>
      <path d="M32 9V38L10 84A7 7 0 0 0 16.5 94H63.5A7 7 0 0 0 70 84L48 38V9" className="outline" />
      <rect x="27.5" y="3.5" width="25" height="6" rx="3" className="rim" />
      <text x="40" y="78" textAnchor="middle" className="pct">{label}</text>
    </svg>
  );
}

const pctOf = (r: TestRun) => { const n = r.passed + r.failed; return n ? r.passed / n : r.ok ? 1 : 0; };
const runLabel = (r: TestRun) => (r.passed + r.failed ? `${Math.floor(pctOf(r) * 100)}%` : r.ok ? '✓' : '✕');

/** One run: passed fills green from the bottom, failed red on top, by their share of the tests. */
function RunFlask({ r, size }: { r: TestRun; size: number }) {
  const pct = pctOf(r);
  return <Flask id={`run-${size}`} size={size} label={runLabel(r)} aria={r.passed + r.failed ? `${r.passed} of ${r.passed + r.failed} passing` : r.ok ? 'passed' : 'failed'}
    layers={[{ kind: 'p', share: pct }, { kind: 'f', share: 1 - pct }]} />;
}

/** Recent runs as slices, oldest at the bottom, newest on top; a run in progress is a yellow slice on top. */
function HistoryFlask({ runs, running, size }: { runs: TestRun[]; running?: TestsState['running']; size: number }) {
  const recent = runs.slice(-(running ? HISTORY - 1 : HISTORY));
  const layers: Layer[] = recent.map((r) => ({ kind: r.ok ? 'p' : 'f', share: 1, title: `${r.ok ? 'Passed' : 'Failed'} · ${r.passed} passed, ${r.failed} failed · ${ago(r.at)}` }));
  if (running) layers.push({ kind: 'run', share: 1, title: `Running · ${running.command}` });
  const last = runs[runs.length - 1];
  const passes = recent.filter((r) => r.ok).length;
  return <Flask id={`hist-${size}`} size={size} layers={layers} even label={last ? runLabel(last) : ''}
    aria={`${passes} of the last ${recent.length} runs passed${running ? ', one running' : ''}`} />;
}
const HISTORY = 20; // runs stacked in the summary's flask

function Summary({ runs, running, toggle, onPick }: { runs: TestRun[]; running?: TestsState['running']; toggle: React.ReactNode; onPick: (i: number) => void }) {
  const last = runs[runs.length - 1];
  const recent = runs.slice(-24);
  const max = Math.max(...recent.map((x) => x.passed + x.failed), 1);
  const streak = (() => { let n = 0; for (let k = runs.length - 1; k >= 0 && runs[k].ok === last.ok; k--) n++; return n; })();
  return (
    <div className="tests">
      <section className={`ts-hero ${last.ok ? 'ok' : 'bad'}`}>
        <HistoryFlask runs={runs} running={running} size={112} />
        <div className="ts-hero-text">
          <div className="ts-verdict">{last.ok ? 'Passing' : 'Failing'}{streak > 1 && <span className="ts-streak">{streak} runs in a row</span>}
            {running && <span className="ts-running" title={running.command}>running now</span>}</div>
          <div className="ts-counts">
            <span className="p"><b>{last.passed}</b> passed</span>
            {last.failed > 0 && <span className="f"><b>{last.failed}</b> failed</span>}
            {last.skipped > 0 && <span className="s"><b>{last.skipped}</b> skipped</span>}
            {last.files && <span className="s"><b>{last.files.length}</b> files</span>}
          </div>
          <div className="ts-meta"><code>{last.command}</code><span>{[last.runner, dur(last.durationMs), ago(last.at)].filter(Boolean).join(' · ')}</span></div>
        </div>
        <div className="ts-corner">{toggle}</div>
      </section>
      {last.failures.length > 0 && (
        <section className="ts-fails">
          <h4>Failing</h4>
          <ul>{last.failures.map((f) => <li key={f}>{f}</li>)}</ul>
        </section>
      )}
      {last.files && last.files.length > 0 && (
        <section>
          <h4>Files</h4>
          <div className="ts-files">{last.files.map((f) => <span key={f.name} className={`ts-file ${f.ok ? 'ok' : 'bad'}`} title={`${f.name}${f.count != null ? ` · ${f.count} tests` : ''}`}>{f.name.split('/').pop()}{f.count != null && <small>{f.count}</small>}</span>)}</div>
        </section>
      )}
      {runs.length > 1 && (
        <section className="ts-history">
          <h4>Recent runs <small>click one for details</small></h4>
          <div className="ts-spark">
            {recent.map((r, i) => {
              const n = r.passed + r.failed, h = n ? Math.max(14, (n / max) * 100) : 40;
              return (
                <button key={i} className="ts-col" title={`${r.ok ? 'passed' : 'failed'} · ${r.passed} passed, ${r.failed} failed · ${r.command}`} onClick={() => onPick(runs.length - recent.length + i)}>
                  <span className={`ts-stack ${r.ok ? 'ok' : 'bad'}`} style={{ height: `${h}%` }}>
                    {r.failed > 0 && <i className="f" style={{ flex: r.failed }} />}
                    <i className="p" style={{ flex: r.passed || (r.ok ? 1 : 0) }} />
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

function RunDetail({ r }: { r: TestRun }) {
  return (
    <section className={`ts-detail ${r.ok ? 'ok' : 'bad'}`}>
      <header>
        <RunFlask r={r} size={84} />
        <div>
          <div className="ts-verdict small">{r.ok ? 'Passed' : 'Failed'}</div>
          <div className="ts-counts"><span className="p"><b>{r.passed}</b> passed</span>{r.failed > 0 && <span className="f"><b>{r.failed}</b> failed</span>}{r.skipped > 0 && <span className="s"><b>{r.skipped}</b> skipped</span>}</div>
          <div className="ts-meta"><code>{r.command}</code><span>{[r.runner, dur(r.durationMs), new Date(r.at).toLocaleTimeString()].filter(Boolean).join(' · ')}</span></div>
        </div>
      </header>
      {r.failures.length > 0 && <div className="ts-fails"><h4>Failing</h4><ul>{r.failures.map((f) => <li key={f}>{f}</li>)}</ul></div>}
      {r.files && r.files.length > 0 && (
        <div><h4>Files</h4><div className="ts-files">{r.files.map((f) => <span key={f.name} className={`ts-file ${f.ok ? 'ok' : 'bad'}`} title={f.name}>{f.name}{f.count != null && <small>{f.count}</small>}</span>)}</div></div>
      )}
      {r.output && <div className="ts-output-wrap"><h4>Output</h4><pre className="ts-output">{r.output}</pre></div>}
    </section>
  );
}
