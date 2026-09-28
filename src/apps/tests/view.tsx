import { useState } from 'react';
import type { AppViewProps } from '../../sdk/react';
import type { TestRun, TestsState } from './index';

const ago = (t: number) => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`; };
const dur = (ms?: number) => (ms == null ? '' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

// Summary: the latest run at a glance (pass-rate ring, counts, what's failing, recent runs).
// Details: every run; pick one to see its files, failures and the end of its output.
export default function TestsView({ state, run, width }: AppViewProps<TestsState>) {
  const runs = state.runs;
  const [sel, setSel] = useState<number | null>(null);
  if (!runs.length) return <div className="ts-empty">Test runs Claude does (npm test, vitest, pytest, go test…) show up here as results.</div>;
  const details = state.view === 'details';
  const toggle = <button className="ts-toggle" onClick={() => run('view', { mode: details ? 'summary' : 'details' })}>{details ? 'Summary' : 'Details'}</button>;
  if (!details) return <Summary runs={runs} toggle={toggle} onPick={(i) => { setSel(i); run('view', { mode: 'details' }); }} />;
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

function Ring({ r, size }: { r: TestRun; size: number }) {
  const total = r.passed + r.failed;
  const pct = total ? r.passed / total : r.ok ? 1 : 0;
  const R = 42, C = 2 * Math.PI * R;
  return (
    <svg className={`ts-ring ${r.ok ? 'ok' : 'bad'}`} width={size} height={size} viewBox="0 0 100 100">
      <circle cx="50" cy="50" r={R} className="track" />
      <circle cx="50" cy="50" r={R} className="fill" strokeDasharray={`${C * pct} ${C}`} transform="rotate(-90 50 50)" />
      <text x="50" y="47" textAnchor="middle" className="pct">{total ? `${Math.floor(pct * 100)}%` : r.ok ? '✓' : '✕'}</text>
      <text x="50" y="64" textAnchor="middle" className="lbl">{total ? 'passing' : r.ok ? 'passed' : 'failed'}</text>
    </svg>
  );
}

function Summary({ runs, toggle, onPick }: { runs: TestRun[]; toggle: React.ReactNode; onPick: (i: number) => void }) {
  const last = runs[runs.length - 1];
  const recent = runs.slice(-24);
  const max = Math.max(...recent.map((x) => x.passed + x.failed), 1);
  const streak = (() => { let n = 0; for (let k = runs.length - 1; k >= 0 && runs[k].ok === last.ok; k--) n++; return n; })();
  return (
    <div className="tests">
      <section className={`ts-hero ${last.ok ? 'ok' : 'bad'}`}>
        <Ring r={last} size={112} />
        <div className="ts-hero-text">
          <div className="ts-verdict">{last.ok ? 'Passing' : 'Failing'}{streak > 1 && <span className="ts-streak">{streak} runs in a row</span>}</div>
          <div className="ts-counts">
            <span className="p"><b>{last.passed}</b> passed</span>
            {last.failed > 0 && <span className="f"><b>{last.failed}</b> failed</span>}
            {last.skipped > 0 && <span className="s"><b>{last.skipped}</b> skipped</span>}
            {last.files && <span className="s"><b>{last.files.length}</b> files</span>}
          </div>
          <div className="ts-meta"><code>{last.command}</code><span>{last.runner} · {dur(last.durationMs)} · {ago(last.at)}</span></div>
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
        <Ring r={r} size={84} />
        <div>
          <div className="ts-verdict small">{r.ok ? 'Passed' : 'Failed'}</div>
          <div className="ts-counts"><span className="p"><b>{r.passed}</b> passed</span>{r.failed > 0 && <span className="f"><b>{r.failed}</b> failed</span>}{r.skipped > 0 && <span className="s"><b>{r.skipped}</b> skipped</span>}</div>
          <div className="ts-meta"><code>{r.command}</code><span>{r.runner} · {dur(r.durationMs)} · {new Date(r.at).toLocaleTimeString()}</span></div>
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
