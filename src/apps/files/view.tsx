import { useMemo, useRef, useState } from 'react';
import type { AppViewProps } from '../../sdk/react';
import type { FilesState, FileStat } from './index';

const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.');
const baseOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const ago = (t: number) => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`; };

export default function FilesView({ state, run }: AppViewProps<FilesState>) {
  const entries = Object.entries(state.files);
  const mode = state.view ?? 'list';
  if (!entries.length) return <div className="fl-empty">Files Claude reads or changes this session show up here.</div>;
  const edited = entries.filter(([, f]) => f.edits).length;
  return (
    <div className="files">
      <header className="fl-bar">
        <span className="fl-sum"><b>{entries.length}</b> files · <b className="e">{edited}</b> changed · <b className="r">{entries.length - edited}</b> only read</span>
        <span className="fl-modes">
          <button className={mode === 'list' ? 'on' : ''} onClick={() => run('view', { mode: 'list' })}>List</button>
          <button className={mode === 'map' ? 'on' : ''} onClick={() => run('view', { mode: 'map' })}>Map</button>
        </span>
      </header>
      {mode === 'list' ? <FileList entries={entries} /> : <FileMap state={state} />}
    </div>
  );
}

function FileList({ entries }: { entries: [string, FileStat][] }) {
  // Folders by most recent activity; files in each by activity.
  const groups = new Map<string, [string, FileStat][]>();
  for (const e of entries) groups.set(dirOf(e[0]), [...(groups.get(dirOf(e[0])) ?? []), e]);
  const sorted = [...groups].sort((a, b) => Math.max(...b[1].map((x) => x[1].last)) - Math.max(...a[1].map((x) => x[1].last)));
  return (
    <div className="fl-list">
      {sorted.map(([dir, fs]) => (
        <section key={dir}>
          <h4>{dir === '.' ? 'project root' : dir}/</h4>
          {fs.sort((a, b) => b[1].edits - a[1].edits || b[1].last - a[1].last).map(([path, f]) => (
            <div key={path} className={`fl-row ${f.edits ? 'edited' : 'read'}`} title={path}>
              <span className="fl-dot" />
              <span className="fl-name">{baseOf(path)}</span>
              {f.edits > 0 && <span className="fl-badge e">{f.edits} edit{f.edits > 1 ? 's' : ''}</span>}
              {f.reads > 0 && <span className="fl-badge r">{f.reads} read{f.reads > 1 ? 's' : ''}</span>}
              <span className="fl-when">{ago(f.last)}</span>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

interface Node { path: string; x: number; y: number; r: number; f: FileStat; dir: string }

/** Folders as hubs on a ring; each folder's files around it; lines = files worked on in the same prompt. */
function layout(files: Record<string, FileStat>): { nodes: Node[]; hubs: { dir: string; x: number; y: number; r: number }[] } {
  const byDir = new Map<string, string[]>();
  for (const p of Object.keys(files)) byDir.set(dirOf(p), [...(byDir.get(dirOf(p)) ?? []), p]);
  const dirs = [...byDir.keys()].sort();
  const ring = dirs.length === 1 ? 0 : 300 + dirs.length * 18;
  const nodes: Node[] = [];
  const hubs = dirs.map((dir, i) => {
    const a = (i / dirs.length) * Math.PI * 2 - Math.PI / 2;
    const hx = Math.cos(a) * ring, hy = Math.sin(a) * ring;
    const ps = byDir.get(dir)!.sort((x, y) => files[y].edits + files[y].reads - (files[x].edits + files[x].reads));
    const spread = 40 + Math.sqrt(ps.length) * 30; // the folder's circle grows with its files
    ps.forEach((path, j) => {
      const f = files[path];
      // Busiest file at the hub, the rest spiral outward inside the circle (golden angle).
      const t = j * 2.399963;
      const d = j === 0 ? 0 : (spread - 18) * Math.sqrt(j / Math.max(1, ps.length - 1));
      nodes.push({ path, dir, f, x: hx + Math.cos(t) * d, y: hy + Math.sin(t) * d, r: 5 + Math.min(14, Math.sqrt(f.edits * 3 + f.reads) * 2.4) });
    });
    return { dir, x: hx, y: hy, r: spread + 22 };
  });
  return { nodes, hubs };
}

function FileMap({ state }: { state: FilesState }) {
  const { nodes, hubs } = useMemo(() => layout(state.files), [state.files]);
  const byPath = useMemo(() => new Map(nodes.map((n) => [n.path, n])), [nodes]);
  const links = useMemo(() => Object.entries(state.links)
    .map(([k, n]) => { const [a, b] = k.split('\u0000'); return { a: byPath.get(a), b: byPath.get(b), n }; })
    .filter((l) => l.a && l.b).sort((x, y) => y.n - x.n).slice(0, 400), [state.links, byPath]);
  const [focus, setFocus] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  // Pan and zoom: drag the background, scroll to zoom around the pointer.
  const bounds = useMemo(() => {
    const m = 40; // margin, so labels and the hint line don't touch the edges
    const xs = hubs.flatMap((h) => [h.x - h.r - m, h.x + h.r + m]), ys = hubs.flatMap((h) => [h.y - h.r - m, h.y + h.r + m * 2]);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  }, [hubs]);
  const [view, setView] = useState<{ x: number; y: number; k: number } | null>(null);
  const v = view ?? { x: bounds.x, y: bounds.y, k: 1 };
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(null);
  const scale = () => { const r = svg.current!.getBoundingClientRect(); return Math.max(bounds.w / r.width, bounds.h / r.height) / v.k; };
  const active = hover ?? focus;
  const near = useMemo(() => new Set(active ? links.filter((l) => l.a!.path === active || l.b!.path === active).flatMap((l) => [l.a!.path, l.b!.path]) : []), [active, links]);
  const top = new Set([...nodes].sort((a, b) => b.r - a.r).slice(0, 12).map((n) => n.path));
  const sel = focus ? byPath.get(focus) : undefined;
  return (
    <div className="fl-map">
      <svg ref={svg} viewBox={`${v.x} ${v.y} ${bounds.w / v.k} ${bounds.h / v.k}`} preserveAspectRatio="xMidYMid meet"
        onWheel={(e) => {
          const r = svg.current!.getBoundingClientRect(), s = scale();
          const px = v.x + (e.clientX - r.left) * s, py = v.y + (e.clientY - r.top) * s;
          const k = Math.max(0.5, Math.min(8, v.k * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
          const f = v.k / k;
          setView({ k, x: px - (px - v.x) * f, y: py - (py - v.y) * f });
        }}
        onPointerDown={(e) => { if ((e.target as Element).closest('.fl-node')) return; drag.current = { px: e.clientX, py: e.clientY, x: v.x, y: v.y }; (e.currentTarget as Element).setPointerCapture(e.pointerId); }}
        onPointerMove={(e) => { const d = drag.current; if (!d) return; const s = scale(); setView({ k: v.k, x: d.x - (e.clientX - d.px) * s, y: d.y - (e.clientY - d.py) * s }); }}
        onPointerUp={() => { if (drag.current) drag.current = null; }}
        onClick={(e) => { if (!(e.target as Element).closest('.fl-node')) setFocus(null); }}>
        {hubs.map((h) => (
          <g key={h.dir} className="fl-hub">
            <circle cx={h.x} cy={h.y} r={h.r} />
            <text x={h.x} y={h.y - h.r + 18} textAnchor="middle">{h.dir === '.' ? 'project root' : h.dir}</text>
          </g>
        ))}
        {links.map((l, i) => {
          const lit = active && (l.a!.path === active || l.b!.path === active);
          return <line key={i} className={`fl-link${lit ? ' lit' : ''}`} x1={l.a!.x} y1={l.a!.y} x2={l.b!.x} y2={l.b!.y} style={{ strokeWidth: Math.min(4, 0.8 + l.n * 0.6) }} />;
        })}
        {nodes.map((n) => (
          <g key={n.path} className={`fl-node ${n.f.edits ? 'edited' : 'read'}${active && !near.has(n.path) && active !== n.path ? ' dim' : ''}${focus === n.path ? ' focus' : ''}`}
            onPointerEnter={() => setHover(n.path)} onPointerLeave={() => setHover(null)} onClick={() => setFocus(n.path === focus ? null : n.path)}>
            <circle cx={n.x} cy={n.y} r={n.r} />
            {(top.has(n.path) || n.path === active || near.has(n.path)) && <text x={n.x} y={n.y + n.r + 13} textAnchor="middle">{baseOf(n.path)}</text>}
          </g>
        ))}
      </svg>
      {sel && (
        <aside className="fl-card">
          <b title={sel.path}>{sel.path}</b>
          <span>{sel.f.edits} edits · {sel.f.reads} reads · last {ago(sel.f.last)}</span>
          {near.size > 1 && <span className="fl-with">Worked on with: {[...near].filter((p) => p !== sel.path).map(baseOf).slice(0, 8).join(', ')}</span>}
        </aside>
      )}
      <div className="fl-hint">Drag to pan · scroll to zoom · click a file · <span className="e">●</span> changed <span className="r">●</span> read · lines: worked on together</div>
    </div>
  );
}
