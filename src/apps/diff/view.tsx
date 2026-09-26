import { useLayoutEffect, useRef } from 'react';
import type { ViewProps } from '../../renderer/viewTypes';
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

export function DiffView({ state, run, width, glass }: ViewProps<DiffState>) {
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
  const cwd = glass.session.cwd;
  const count = (r: Revision) => {
    let a = 0, d = 0;
    for (const h of r.hunks) for (const l of h.lines) { if (l[0] === '+') a++; else if (l[0] === '-') d++; }
    return { a, d };
  };
  const c = count(rev);
  return (
    <div className={`diff${wide ? ' wide' : ''}`}>
      {wide ? (
        <ul className="d-files" ref={filesRef}>
          {state.files.map((f) => (
            <li key={f}>
              <button className={f === file ? 'on' : ''} onClick={() => run('select', { path: f })} title={f}>
                <span className="fname">{f.split('/').pop()}</span>
                <span className="fdir">{shortPath(f, cwd).split('/').slice(0, -1).join('/')}</span>
                <span className="fcount">{state.revisions[f].length}</span>
              </button>
            </li>
          ))}
        </ul>
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
          <span className="d-when">{rev.source} · {timeAgo(rev.at)}</span>
        </div>
        {rev.note && <p className="d-note">{rev.note}</p>}
        <Hunks key={`${file}:${idx}:${rev.at}`} rev={rev} />
      </div>
    </div>
  );
}
