import { type ReactNode, useEffect, useMemo, useState } from 'react';
import type { AppViewProps } from '../../sdk/react';
import type { FilesState, FileStat } from './index';

const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.');
const baseOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const ago = (t: number) => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`; };

const RECENT_MS = 2 * 60_000; // touched this recently: lit up in the list and tree

export default function FilesView({ state, run, host }: AppViewProps<FilesState>) {
  // A changed file opens in Changes, with its diff selected.
  const open = (path: string) => host('show-change', { path });
  const entries = Object.entries(state.files);
  const mode = state.view === 'tree' ? 'tree' : 'list';
  // Re-render every 30s so "just now" and the recent glow age out on their own.
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 30_000); return () => clearInterval(t); }, []);
  if (!entries.length) return <div className="fl-empty">Files Claude reads or changes this session show up here.</div>;
  const edited = entries.filter(([, f]) => f.edits).length;
  return (
    <div className="files">
      <header className="fl-bar">
        <span className="fl-sum"><b>{entries.length}</b> files · <b className="e">{edited}</b> changed · <b className="r">{entries.length - edited}</b> only read</span>
        <span className="fl-modes">
          {(['list', 'tree'] as const).map((m) => <button key={m} className={mode === m ? 'on' : ''} onClick={() => run('view', { mode: m })}>{m[0].toUpperCase() + m.slice(1)}</button>)}
        </span>
      </header>
      {mode === 'list' ? <FileList entries={entries} open={open} /> : <FileTree entries={entries} open={open} />}
    </div>
  );
}

type Open = (path: string) => void;

function Row({ path, f, name, depth, open }: { path: string; f: FileStat; name: ReactNode; depth?: number; open: Open }) {
  const recent = Date.now() - f.last < RECENT_MS;
  return (
    <div className={`fl-row ${f.edits ? 'edited' : 'read'}${recent ? ' recent' : ''}`} title={f.edits ? `${path}: show the change` : path}
      style={depth != null ? { paddingLeft: 8 + depth * 16 } : undefined} onClick={f.edits ? () => open(path) : undefined}>
      <span className="fl-dot" />
      <span className="fl-name">{name}</span>
      {f.edits > 0 && <span className="fl-badge e">{f.edits} edit{f.edits > 1 ? 's' : ''}</span>}
      {f.reads > 0 && <span className="fl-badge r">{f.reads} read{f.reads > 1 ? 's' : ''}</span>}
      <span className="fl-when">{ago(f.last)}</span>
    </div>
  );
}

/** Most recently touched first: a file Claude comes back to later jumps to the top. */
function FileList({ entries, open }: { entries: [string, FileStat][]; open: Open }) {
  const sorted = [...entries].sort((a, b) => b[1].last - a[1].last);
  return (
    <div className="fl-list">
      {sorted.map(([path, f]) => (
        <Row key={path} path={path} f={f} open={open} name={<>{baseOf(path)}{dirOf(path) !== '.' && <small>{dirOf(path)}/</small>}</>} />
      ))}
    </div>
  );
}

interface Dir { name: string; dirs: Map<string, Dir>; files: [string, FileStat][]; edits: number; total: number; last: number }

/** The project's folders, only the parts Claude touched; single-child folder chains collapse (src/apps/files). */
function buildTree(entries: [string, FileStat][]): Dir {
  const root: Dir = { name: '', dirs: new Map(), files: [], edits: 0, total: 0, last: 0 };
  for (const e of entries) {
    const parts = e[0].split('/');
    let d = root;
    const bump = (x: Dir) => { x.total++; x.edits += e[1].edits ? 1 : 0; x.last = Math.max(x.last, e[1].last); };
    bump(d);
    for (const p of parts.slice(0, -1)) {
      if (!d.dirs.has(p)) d.dirs.set(p, { name: p, dirs: new Map(), files: [], edits: 0, total: 0, last: 0 });
      d = d.dirs.get(p)!;
      bump(d);
    }
    d.files.push(e);
  }
  const squash = (d: Dir): Dir => {
    for (const [k, c] of d.dirs) d.dirs.set(k, squash(c));
    if (d.name && d.dirs.size === 1 && !d.files.length) { const only = [...d.dirs.values()][0]; return { ...only, name: `${d.name}/${only.name}` }; }
    return d;
  };
  return squash(root);
}

function FileTree({ entries, open }: { entries: [string, FileStat][]; open: Open }) {
  const tree = useMemo(() => buildTree(entries), [entries]);
  const [shut, setShut] = useState<Set<string>>(new Set());
  const toggle = (k: string) => setShut((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const render = (d: Dir, key: string, depth: number): ReactNode[] => {
    const out: ReactNode[] = [];
    for (const c of [...d.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      const k = `${key}/${c.name}`, expanded = !shut.has(k), recent = Date.now() - c.last < RECENT_MS;
      out.push(
        <div key={k} className={`fl-dir${recent ? ' recent' : ''}`} style={{ paddingLeft: 8 + depth * 16 }} onClick={() => toggle(k)}>
          <span className={`fl-caret${expanded ? ' open' : ''}`}>▸</span>
          <span className="fl-dirname">{c.name}/</span>
          <span className="fl-dircount">{c.edits > 0 && <b>{c.edits} changed</b>}{c.total} file{c.total > 1 ? 's' : ''}</span>
        </div>,
      );
      if (expanded) out.push(...render(c, k, depth + 1));
    }
    for (const [path, f] of [...d.files].sort((a, b) => baseOf(a[0]).localeCompare(baseOf(b[0])))) out.push(<Row key={path} path={path} f={f} name={baseOf(path)} depth={depth} open={open} />);
    return out;
  };
  return <div className="fl-list fl-tree">{render(tree, '', 0)}</div>;
}
