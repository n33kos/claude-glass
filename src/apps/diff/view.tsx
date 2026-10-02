import { useLayoutEffect, useRef } from 'react';
import type { AppViewProps } from '../../sdk/react';
import { timeAgo } from '../../renderer/viewTypes';
import type { DiffState, Revision } from './index';

function shortPath(p: string, cwd: string) {
  return cwd && p.startsWith(cwd + '/') ? p.slice(cwd.length + 1) : p;
}

function Hunks({ rev }: { rev: Revision }) {
  if (!rev.hunks.length) return <div className="d-empty">No line changes.</div>;
  return (
    <div className="d-hunks">
      {rev.hunks.map((h, i) => {
        let o = h.oldStart, n = h.newStart;
        return (
          <table className="d-hunk" key={i}>
            <tbody>
              <tr className="d-head"><td colSpan={3}>@@ −{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@</td></tr>
              {h.lines.map((l, j) => {
                const t = l[0];
                const row = (
                  <tr key={j} className={t === '+' ? 'add' : t === '-' ? 'del' : 'ctx'}>
                    <td className="ln">{t === '+' ? '' : o}</td>
                    <td className="ln">{t === '-' ? '' : n}</td>
                    <td className="code">{l.slice(1) || ' '}</td>
                  </tr>
                );
                if (t !== '+') o++;
                if (t !== '-') n++;
                return row;
              })}
            </tbody>
          </table>
        );
      })}
    </div>
  );
}

/** The revision as plain text, for attaching to the next prompt (point and ask). */
function revisionText(path: string, rev: Revision): string {
  return [`${path} (${rev.source})`, ...rev.hunks.flatMap((h) => [`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...h.lines])].join('\n');
}

export default function DiffView({ state, run, width, session, host }: AppViewProps<DiffState>) {
  // Newest edit first: when a new revision lands, the file list scrolls back to its top entry.
  const filesRef = useRef<HTMLUListElement>(null);
  const newest = state.files[0] ? `${state.files[0]}:${state.revisions[state.files[0]]?.length}` : '';
  useLayoutEffect(() => { filesRef.current?.scrollTo({ top: 0 }); }, [newest]);
  const file = state.selected && state.revisions[state.selected] ? state.selected : state.files[0];
  if (!file) return <div className="d-empty big">File changes will appear here as Claude edits.</div>;
  const revs = state.revisions[file];
  const cur = state.cursor[file] ?? -1;
  const idx = cur < 0 || cur >= revs.length ? revs.length - 1 : cur;
  const rev = revs[idx];
  const wide = width > 640;
  const cwd = session.cwd;
  const count = (r: Revision) => {
    let a = 0, d = 0;
    for (const h of r.hunks) for (const l of h.lines) { if (l[0] === '+') a++; else if (l[0] === '-') d++; }
    return { a, d };
  };
  const c = count(rev);
  // "This turn": only the files the latest turn changed.
  const turnFiles = state.turn ? state.files.filter((f) => state.revisions[f]?.some((r) => r.turnId === state.turn)) : [];
  const byTurn = state.scope === 'turn' && turnFiles.length > 0;
  const listed = byTurn ? turnFiles : state.files;
  return (
    <div className={`diff${wide ? ' wide' : ''}`}>
      {wide ? (
        <div className="d-side">
          {turnFiles.length > 0 && (
            <div className="d-scope" role="group" aria-label="Which changes">
              <button className={byTurn ? '' : 'on'} aria-pressed={!byTurn} onClick={() => run('scope', { scope: 'all' })}>All</button>
              <button className={byTurn ? 'on' : ''} aria-pressed={byTurn} onClick={() => run('scope', { scope: 'turn' })}>This turn · {turnFiles.length}</button>
            </div>
          )}
        <ul className="d-files" ref={filesRef}>
          {listed.map((f) => (
            <li key={f}>
              <button className={f === file ? 'on' : ''} onClick={() => run('select', { path: f })} title={f}>
                <span className="fname">{f.split('/').pop()}</span>
                <span className="fdir">{shortPath(f, cwd).split('/').slice(0, -1).join('/')}</span>
                <span className="fcount">{state.revisions[f].length}</span>
              </button>
            </li>
          ))}
        </ul>
        </div>
      ) : null}
      <div className="d-main">
        <div className="d-bar">
          {!wide && state.files.length > 1 ? (
            <select value={file} onChange={(e) => run('select', { path: e.target.value })}>
              {state.files.map((f) => <option key={f} value={f}>{shortPath(f, cwd)}</option>)}
            </select>
          ) : <span className="d-path" title={file}>{shortPath(file, cwd)}</span>}
          <span className="d-stat"><span className="plus">+{c.a}</span> <span className="minus">−{c.d}</span></span>
          <span className="d-nav">
            <button disabled={idx === 0} onClick={() => run('select', { path: file, index: idx - 1 })} aria-label="Previous revision">‹</button>
            <span>{idx + 1} / {revs.length}</span>
            <button disabled={idx === revs.length - 1} onClick={() => run('select', { path: file, index: idx + 1 === revs.length - 1 ? -1 : idx + 1 })} aria-label="Next revision">›</button>
          </span>
          {wide && <span className="d-when">{rev.source} · {timeAgo(rev.at)}</span>}
          <button className="d-attach" title="Attach this change to your next prompt (Claude reads it with what you say)"
            onClick={() => host('attach', { label: `${file.split('/').pop()} · change ${idx + 1}/${revs.length}`, text: revisionText(shortPath(file, cwd), rev) })}>{wide ? 'Ask about this' : 'Ask'}</button>
        </div>
        {rev.note && <p className="d-note">{rev.note}</p>}
        <Hunks key={`${file}:${idx}:${rev.at}`} rev={rev} />
      </div>
    </div>
  );
}
