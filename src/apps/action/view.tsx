import type { AppViewProps } from '../../sdk/react';
import type { ActionRequest, ActionState, Choice } from './index';

const ANSWERED: Record<string, string> = {
  allow: 'Allowed', always: 'Always allowed', deny: 'Denied', terminal: 'Answered in Claude Code',
};
const BY: Record<string, string> = { glass: 'here', terminal: 'in the terminal', timeout: 'left to Claude Code (no answer)', interrupted: 'the turn was interrupted' };

export default function ActionView({ state, run, session }: AppViewProps<ActionState>) {
  const reqs = [...state.requests].reverse(); // newest first
  if (!reqs.length) return <div className="ac-empty">When Claude Code asks your permission, you can answer here.</div>;
  return (
    <div className="action">
      {reqs.map((r) => <Request key={r.id} r={r} cwd={session.cwd} run={run} />)}
    </div>
  );
}

function Request({ r, cwd, run }: { r: ActionRequest; cwd: string; run: AppViewProps['run'] }) {
  const rel = (t: string) => (cwd ? t.split(cwd + '/').join('') : t);
  const answer = (choice: Choice) => run('answer', { id: r.id, choice });
  const pending = r.status === 'pending';
  const lines = (r.detail ?? '').split('\n');
  return (
    <article className={`ac-req ${r.status}${r.answer ? ` ac-${r.answer.choice}` : ''}`} aria-live={pending ? 'assertive' : undefined}>
      <div className="ac-ask">{pending ? 'Claude wants to' : ANSWERED[r.answer?.choice ?? ''] ?? 'Answered'}{!pending && r.answer?.by && r.answer.by !== 'glass' ? ` · ${BY[r.answer.by] ?? r.answer.by}` : ''}</div>
      <div className="ac-what"><b>{r.tool}</b> {rel(r.summary.startsWith(r.tool) ? r.summary.slice(r.tool.length) : r.summary.replace(/^\$ /, ''))}</div>
      {r.detail && (
        <pre className="ac-detail">{lines.map((l, i) => (
          <span key={i} className={l.startsWith('+ ') ? 'add' : l.startsWith('- ') ? 'del' : ''}>{rel(l)}{'\n'}</span>
        ))}</pre>
      )}
      {pending && (
        <div className="ac-buttons">
          <button className="primary" onClick={() => answer('allow')}>Allow</button>
          {r.canAlways && <button onClick={() => answer('always')} title="Allow, and don't ask again for this kind of call">Always allow</button>}
          <button className="deny" onClick={() => answer('deny')}>Deny</button>
          <span className="ac-hint">or answer in the terminal</span>
        </div>
      )}
      {!pending && <button className="ac-dismiss" onClick={() => run('dismiss', { id: r.id })} aria-label="Dismiss">×</button>}
    </article>
  );
}
