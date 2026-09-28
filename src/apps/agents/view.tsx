import { useEffect, useState } from 'react';
import { renderMarkdown } from '../../renderer/markdown';
import type { AppViewProps } from '../../sdk/react';
import type { AgentRun, AgentsState } from './index';

const took = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`);

export default function AgentsView({ state }: AppViewProps<AgentsState>) {
  const runs = [...state.runs].reverse(); // newest first
  const running = runs.some((r) => r.status === 'running');
  const [, tick] = useState(0);
  useEffect(() => { if (!running) return; const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, [running]);
  if (!runs.length) return <div className="ag-empty">Subagents Claude starts show up here: their task, whether they're still working, and what they report.</div>;
  const live = runs.filter((r) => r.status === 'running').length;
  return (
    <div className="agents">
      <div className="ag-sum">{live ? <><span className="ag-dot" /> {live} running</> : 'All done'} · {runs.length} total</div>
      {runs.map((r) => <Run key={r.key} r={r} />)}
    </div>
  );
}

function Run({ r }: { r: AgentRun }) {
  const [open, setOpen] = useState(r.status === 'running');
  const elapsed = (r.endedAt ?? Date.now()) - r.startedAt;
  return (
    <article className={`ag-run ${r.status}`}>
      <header onClick={() => setOpen((o) => !o)}>
        <span className="ag-state" aria-label={r.status}>{r.status === 'done' ? '✓' : r.status === 'failed' ? '!' : ''}</span>
        <span className="ag-desc">{r.description}</span>
        <span className="ag-type">{r.type}{r.background ? ' · background' : ''}</span>
        <span className="ag-time">{took(elapsed)}</span>
      </header>
      {open && (
        <div className="ag-body">
          <div className="ag-label">Asked</div>
          <p className="ag-prompt">{r.prompt}</p>
          {r.result && <>
            <div className="ag-label">{r.status === 'failed' ? 'Error' : 'Reported'}</div>
            <div className="ag-result md" dangerouslySetInnerHTML={{ __html: renderMarkdown(r.result) }} />
          </>}
        </div>
      )}
    </article>
  );
}
