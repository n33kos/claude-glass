import { useState } from 'react';
import type { AppViewProps } from '../../sdk/react';
import type { ActionRequest, ActionState, Choice, Question } from './index';

const ANSWERED: Record<string, string> = {
  allow: 'Allowed', always: 'Always allowed', deny: 'Denied', terminal: 'Answered in Claude Code',
};
const BY: Record<string, string> = { glass: 'here', terminal: 'in the terminal', timeout: 'left to Claude Code (no answer)', interrupted: 'the turn was interrupted' };

export default function ActionView({ state, run, session }: AppViewProps<ActionState>) {
  const reqs = [...state.requests].reverse(); // newest first
  if (!reqs.length) return <div className="ac-empty">When Claude Code asks your permission (or, if you turned it on, Claude asks a question), you can answer here.</div>;
  return (
    <div className="action">
      {reqs.map((r) => <Request key={r.id} r={r} cwd={session.cwd} run={run} />)}
    </div>
  );
}

/**
 * Claude's questions: pick an option per question (several for multi-select) or write your own;
 * a single question with one choice to make sends at once.
 */
function QuestionRequest({ r, run }: { r: ActionRequest; run: AppViewProps['run'] }) {
  const qs = r.questions ?? [];
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [own, setOwn] = useState<Record<string, string>>({});
  const pending = r.status === 'pending';
  const value = (q: Question) => (own[q.question]?.trim() || (picked[q.question] ?? []).join(', '));
  const send = (answers: Record<string, string>) => run('answer', { id: r.id, answers });
  const instant = qs.length === 1 && !qs[0].multiSelect;
  const pick = (q: Question, label: string) => {
    if (instant) return send({ [q.question]: label });
    const cur = picked[q.question] ?? [];
    setPicked({ ...picked, [q.question]: q.multiSelect ? (cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label]) : [label] });
    setOwn({ ...own, [q.question]: '' });
  };
  const ready = qs.every((q) => value(q));
  return (
    <article className={`ac-req ac-question ${r.status}`} aria-live={pending ? 'assertive' : undefined}>
      <div className="ac-ask">{pending ? (qs.length > 1 ? `Claude asks ${qs.length} things` : 'Claude asks') : 'Answered'}{!pending && r.answer?.by && r.answer.by !== 'glass' ? ` · ${BY[r.answer.by] ?? r.answer.by}` : ''}</div>
      {qs.map((q) => (
        <div key={q.question} className="ac-q">
          {q.header && <span className="ac-chip">{q.header}</span>}
          <p className="ac-qtext">{q.question}</p>
          {pending ? (
            <>
              <div className="ac-options">
                {q.options.map((o) => (
                  <button key={o.label} className={(picked[q.question] ?? []).includes(o.label) ? 'on' : ''} onClick={() => pick(q, o.label)} title={o.description}>
                    <b>{o.label}</b>{o.description && <span>{o.description}</span>}
                  </button>
                ))}
              </div>
              <input className="ac-own" placeholder="Or say it your own way" value={own[q.question] ?? ''}
                onChange={(e) => setOwn({ ...own, [q.question]: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Enter' && instant && e.currentTarget.value.trim()) send({ [q.question]: e.currentTarget.value.trim() }); }} />
            </>
          ) : <p className="ac-given">{r.answer?.answers?.[q.question] ?? (r.answer?.by === 'terminal' ? 'Answered in Claude Code' : '—')}</p>}
        </div>
      ))}
      {pending && !instant && (
        <div className="ac-buttons">
          <button className="primary" disabled={!ready} onClick={() => send(Object.fromEntries(qs.map((q) => [q.question, value(q)])))}>Send</button>
          <span className="ac-hint">or answer in the terminal</span>
        </div>
      )}
      {pending && instant && <div className="ac-buttons"><span className="ac-hint">or answer in the terminal</span></div>}
      {!pending && <button className="ac-dismiss" onClick={() => run('dismiss', { id: r.id })} aria-label="Dismiss">×</button>}
    </article>
  );
}

function Request({ r, cwd, run }: { r: ActionRequest; cwd: string; run: AppViewProps['run'] }) {
  if (r.kind === 'question') return <QuestionRequest r={r} run={run} />;
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
