import type { AppViewProps } from '../../sdk/react';
import type { TestRun, TestsState } from './index';

const ago = (t: number) => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`; };
const dur = (ms?: number) => (ms == null ? '' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

export default function TestsView({ state }: AppViewProps<TestsState>) {
  const runs = state.runs;
  if (!runs.length) return <div className="ts-empty">Test runs Claude does (npm test, vitest, pytest, go test…) show up here as results.</div>;
  const last = runs[runs.length - 1];
  const total = last.passed + last.failed + last.skipped;
  return (
    <div className="tests">
      <section className={`ts-latest ${last.ok ? 'ok' : 'bad'}`}>
        <div className="ts-verdict">{last.ok ? 'Passing' : 'Failing'}</div>
        <div className="ts-counts">
          {total > 0 ? <>
            <span className="p"><b>{last.passed}</b> passed</span>
            {last.failed > 0 && <span className="f"><b>{last.failed}</b> failed</span>}
            {last.skipped > 0 && <span className="s"><b>{last.skipped}</b> skipped</span>}
          </> : <span className="s">no counts in the output</span>}
        </div>
        <div className="ts-meta"><code>{last.command}</code> · {last.runner} · {dur(last.durationMs)} · {ago(last.at)}</div>
        {total > 0 && (
          <div className="ts-bar">
            <i className="p" style={{ flex: last.passed }} /><i className="f" style={{ flex: last.failed }} /><i className="s" style={{ flex: last.skipped }} />
          </div>
        )}
      </section>
      {last.failures.length > 0 && (
        <section className="ts-fails">
          <h4>Failing</h4>
          <ul>{last.failures.map((f) => <li key={f}>{f}</li>)}</ul>
        </section>
      )}
      {runs.length > 1 && (
        <section className="ts-history">
          <h4>Recent runs</h4>
          <div className="ts-spark" title="Each bar is a run, newest on the right; height = tests, red = failures">
            {runs.slice(-24).map((r, i) => <Bar key={i} r={r} max={Math.max(...runs.slice(-24).map((x) => x.passed + x.failed), 1)} />)}
          </div>
        </section>
      )}
    </div>
  );
}

function Bar({ r, max }: { r: TestRun; max: number }) {
  const n = r.passed + r.failed;
  const h = n ? Math.max(12, (n / max) * 100) : 40;
  return (
    <span className="ts-col" title={`${r.ok ? 'passed' : 'failed'} · ${r.passed} passed, ${r.failed} failed · ${r.command}`}>
      <span className={`ts-stack ${r.ok ? 'ok' : 'bad'}`} style={{ height: `${h}%` }}>
        {r.failed > 0 && <i className="f" style={{ flex: r.failed }} />}
        <i className="p" style={{ flex: r.passed || (r.ok ? 1 : 0) }} />
      </span>
    </span>
  );
}
