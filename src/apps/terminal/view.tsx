import { useMemo, useState } from 'react';
import { useStickToBottom } from '../../renderer/hooks';
import type { ViewProps } from '../../renderer/viewTypes';
import type { TermEntry, TerminalState } from './index';

const PREVIEW_LINES = 8;

function Entry({ e, cwd }: { e: TermEntry; cwd: string }) {
  const rel = (t: string) => (cwd ? t.split(cwd + '/').join('') : t);
  const [open, setOpen] = useState(false);
  const lines = e.output ? e.output.split('\n') : [];
  const long = lines.length > PREVIEW_LINES;
  const shown = open || !long ? lines : lines.slice(0, PREVIEW_LINES);
  if (e.kind === 'agent') return <div className="t-agent">{e.summary}</div>;
  if (e.kind === 'log') return <div className="t-log">{e.summary}</div>;
  const isBash = e.tool === 'Bash';
  return (
    <div className={`t-entry t-${e.status}`}>
      <div className="t-cmd">
        <span className="t-mark">{e.status === 'running' ? <span className="spin" /> : e.status === 'error' ? '✕' : isBash ? '' : '●'}</span>
        <span className={isBash ? 't-bash' : 't-tool'}>{isBash ? e.summary : <><b>{e.tool}</b>{rel(e.summary.slice(e.tool!.length))}</>}</span>
        {e.durationMs != null && e.durationMs > 400 && <span className="t-dur">{(e.durationMs / 1000).toFixed(1)}s</span>}
      </div>
      {shown.length > 0 && (
        <pre className="t-out">{rel(shown.join('\n'))}</pre>
      )}
      {long && <button className="t-more" onClick={() => setOpen(!open)}>{open ? 'Show less' : `Show ${lines.length - PREVIEW_LINES} more lines`}</button>}
    </div>
  );
}

export function TerminalView({ state, run, canvas }: ViewProps<TerminalState>) {
  const tools = useMemo(() => [...new Set(state.entries.filter((e) => e.tool).map((e) => e.tool!))].sort(), [state.entries]);
  const hidden = new Set(state.hidden);
  const visible = state.entries.filter((e) => !e.tool || !hidden.has(e.tool));
  const ref = useStickToBottom<HTMLDivElement>(visible.length + (visible[visible.length - 1]?.status ?? ''));
  const toggle = (t: string) => run('filter', { hidden: hidden.has(t) ? state.hidden.filter((x) => x !== t) : [...state.hidden, t] });
  return (
    <div className="terminal">
      {tools.length > 1 && (
        <div className="t-filters scroll-x" role="toolbar" aria-label="Filter tool calls">
          {tools.map((t) => (
            <button key={t} className={hidden.has(t) ? 'off' : ''} onClick={() => toggle(t)} aria-pressed={!hidden.has(t)}>{t}</button>
          ))}
        </div>
      )}
      <div className="t-scroll" ref={ref}>
        {visible.length === 0 && <div className="t-empty">Tool calls show up here as Claude works.</div>}
        {visible.map((e) => <Entry key={e.id} e={e} cwd={canvas.session.cwd} />)}
      </div>
    </div>
  );
}
