import { useMemo, useState } from 'react';
import { useStickToBottom } from '../../renderer/hooks';
import type { AppViewProps } from '../../sdk/react';
import type { TermEntry, TerminalState } from './index';

const PREVIEW_LINES = 8;

const LockIcon = () => (
  <svg viewBox="0 0 12 12" width="10" height="10" aria-label="awaiting permission"><path fill="currentColor" d="M3.5 5V3.6a2.5 2.5 0 015 0V5h.5a1 1 0 011 1v4a1 1 0 01-1 1H3a1 1 0 01-1-1V6a1 1 0 011-1zm1.3 0h2.4V3.6a1.2 1.2 0 00-2.4 0z" /></svg>
);

function Entry({ e, cwd, locked }: { e: TermEntry; cwd: string; locked: boolean }) {
  const rel = (t: string) => (cwd ? t.split(cwd + '/').join('') : t);
  const [open, setOpen] = useState(false);
  const lines = e.output ? e.output.split('\n') : [];
  const long = lines.length > PREVIEW_LINES;
  const shown = open || !long ? lines : lines.slice(0, PREVIEW_LINES);
  if (e.kind === 'agent') return <div className="t-agent">{e.summary}</div>;
  if (e.kind === 'log') return <div className="t-log">{e.summary}</div>;
  if (e.kind === 'turn') return <div className="t-turn" title={e.summary}><span>{e.summary}</span></div>;
  const isBash = e.tool === 'Bash';
  return (
    <div className={`t-entry t-${e.status}${locked ? ' t-locked' : ''}${e.sub ? ' t-sub' : ''}`} title={e.sub ? 'A subagent\'s call' : undefined}>
      <div className="t-cmd">
        <span className="t-mark">{locked ? <LockIcon /> : e.status === 'running' ? <span className="spin" /> : e.status === 'error' ? '✕' : isBash ? '' : '●'}</span>
        <span className={isBash ? 't-bash' : 't-tool'}>{isBash ? e.summary : <><b>{e.tool}</b>{rel(e.summary.slice(e.tool!.length))}</>}</span>
        {locked && <span className="t-await">awaiting permission</span>}
        {e.durationMs != null && e.durationMs > 400 && <span className="t-dur">{(e.durationMs / 1000).toFixed(1)}s</span>}
      </div>
      {shown.length > 0 && (
        <pre className="t-out">{rel(shown.join('\n'))}</pre>
      )}
      {long && <button className="t-more" onClick={() => setOpen(!open)}>{open ? 'Show less' : `Show ${lines.length - PREVIEW_LINES} more lines`}</button>}
    </div>
  );
}

export default function TerminalView({ state, run, session }: AppViewProps<TerminalState>) {
  const tools = useMemo(() => [...new Set(state.entries.filter((e) => e.tool).map((e) => e.tool!))].sort(), [state.entries]);
  const hidden = new Set(state.hidden);
  const visible = state.entries.filter((e) => !e.tool || !hidden.has(e.tool));
  const ref = useStickToBottom<HTMLDivElement>(visible[visible.length - 1]?.id, visible[visible.length - 1]?.status);
  // The call held up by a permission prompt: matched by id, else the latest running call (of that tool).
  const w = session.ended ? undefined : session.waiting;
  const lockedId = w?.kind !== 'permission' ? undefined
    : w.toolUseId && state.entries.some((e) => e.id === w.toolUseId) ? w.toolUseId
    : [...state.entries].reverse().find((e) => e.status === 'running' && (!w.tool || e.tool === w.tool))?.id;
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
        {visible.map((e) => <Entry key={e.id} e={e} cwd={session.cwd} locked={e.id === lockedId} />)}
      </div>
    </div>
  );
}
