import type { CSSProperties, ReactNode } from 'react';
import type { AppViewProps } from '../../sdk/react';
import type { DiagramState, Tone } from './index';

// Diagrams that fill their window. Every template lays itself out from the space it has (width and
// height from the glass), switches orientation with the window's shape, and scales type and cards
// to fit, so a diagram reads the same in a big pane, a sidebar or a small tile.
// Items are strings or { title, note, tone }; tones: good | bad | warn | info | muted.

type Item = { title?: string; note?: string; tone?: Tone; [k: string]: any };
const item = (v: any): Item => (typeof v === 'string' ? { title: v } : v ?? {});

// No red in the default palette: red is for tone "bad" only, so it always means something.
// Colors come from the design tokens (docs/design.md): the categorical series, and status tones.
const PALETTE = ['var(--cat-1)', 'var(--cat-2)', 'var(--cat-3)', 'var(--cat-4)', 'var(--cat-5)', 'var(--cat-6)'];
const TONES: Record<string, string> = { good: 'var(--ok)', bad: 'var(--bad)', warn: 'var(--warn)', info: 'var(--info)', muted: 'var(--gray-9)' };
const accent = (it: Item, i: number) => (it.tone && TONES[it.tone]) || PALETTE[i % PALETTE.length];
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const acc = (c: string, extra: CSSProperties = {}): CSSProperties => ({ ['--a' as string]: c, ...extra });

interface Box { W: number; H: number; s: number } // content area and a type scale (px per "unit")

export default function DiagramView({ state, width, height }: AppViewProps<DiagramState>) {
  if (!state.template) return <div className="dg-empty">Claude draws diagrams here from templates: flows, sequences, layers, timelines, comparisons, trees, cycles and stats.</div>;
  const d = state.data ?? {};
  const pad = clamp(Math.min(width, height) * 0.045, 12, 32);
  const titleH = state.title ? clamp(Math.min(width, height) * 0.075, 26, 52) : 0;
  const box: Box = { W: Math.max(120, width - pad * 2), H: Math.max(120, height - pad * 2 - titleH), s: clamp(Math.min(width * 0.75, height) / 42, 10.5, 17) };
  const body: Record<string, () => ReactNode> = {
    flow: () => <Flow b={box} steps={(d.steps ?? []).map(item)} />,
    sequence: () => <Sequence b={box} actors={d.actors} messages={d.messages ?? []} />,
    layers: () => <Layers b={box} layers={(d.layers ?? []).map(item)} />,
    timeline: () => <Timeline b={box} events={(d.events ?? []).map(item)} />,
    compare: () => <Compare b={box} columns={(d.columns ?? []).map(item)} />,
    tree: () => <Tree b={box} root={item(d.root)} />,
    cycle: () => <Cycle b={box} steps={(d.steps ?? []).map(item)} center={d.center} />,
    stats: () => <Stats b={box} items={(d.items ?? []).map(item)} />,
  };
  return (
    <div className="diagram" style={{ padding: pad, fontSize: box.s }}>
      {state.title && <h2 className="dg-title" style={{ height: titleH, fontSize: clamp(titleH * 0.5, 15, 26) }}>{state.title}</h2>}
      <div className="dg-stage" style={{ width: box.W, height: box.H }}>{body[state.template]?.()}</div>
    </div>
  );
}

/** A glowing card, positioned absolutely when given a rect. */
function Node({ it, color, n, style, className = '', delay = 0 }: { it: Item; color: string; n?: number; style?: CSSProperties; className?: string; delay?: number }) {
  return (
    <div className={`dg-node ${className}${it.tone === 'muted' ? ' muted' : ''}`} style={acc(color, { ...style, animationDelay: `${delay}ms` })}>
      {n != null && <span className="dg-badge">{n}</span>}
      <b>{it.title}</b>
      {it.note && <small>{it.note}</small>}
    </div>
  );
}

/** An id-safe name for a color (they're token references like var(--cat-1)). */
const markerId = (c: string) => `ah-${c.replace(/[^A-Za-z0-9]/g, '')}`;

/** Gradient defs for connectors (one per color) + the flowing-dash overlay style. */
function Defs({ colors }: { colors: string[] }) {
  return (
    <defs>
      {[...new Set(colors)].map((c) => (
        <marker key={c} id={markerId(c)} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M1 1 L9 5 L1 9 z" style={{ fill: c }} />
        </marker>
      ))}
    </defs>
  );
}
function Wire({ d, color, arrow = true, dashed = false }: { d: string; color: string; arrow?: boolean; dashed?: boolean }) {
  return (
    <g className="dg-wire" style={acc(color)}>
      <path d={d} className={`base${dashed ? ' dashed' : ''}`} markerEnd={arrow ? `url(#${markerId(color)})` : undefined} />
      {!dashed && <path d={d} className="flow" />}
    </g>
  );
}

// ---- flow: steps in order; a row when wide, a column when tall, a snake when there are many ----
function Flow({ b, steps }: { b: Box; steps: Item[] }) {
  const n = Math.max(steps.length, 1);
  const wide = b.W / b.H >= 1.05;
  const minMain = b.s * 9; // narrowest a card may get along the flow
  const perLine = clamp(Math.floor(((wide ? b.W : b.H) + b.s * 3) / (minMain + b.s * 3)), 1, n);
  const lines = Math.ceil(n / perLine);
  const gapMain = b.s * 3.2, gapCross = b.s * 3;
  const main = wide ? b.W : b.H, cross = wide ? b.H : b.W;
  const cellMain = (main - gapMain * (perLine - 1)) / perLine;
  const cellCross = (cross - gapCross * (lines - 1)) / lines;
  // Cards keep a card's proportions; spare room goes to the wires and margins, not into giant boxes.
  const cardMain = Math.min(cellMain, wide ? b.s * 18 : b.s * 7.5);
  const cardCross = Math.min(cellCross, wide ? b.s * 9 : b.s * 26);
  const rects = steps.map((_, i) => {
    const line = Math.floor(i / perLine);
    let k = i % perLine;
    if (line % 2 === 1) k = perLine - 1 - k; // snake back on alternate lines
    const m = k * (cellMain + gapMain) + (cellMain - cardMain) / 2, c = line * (cellCross + gapCross) + (cellCross - cardCross) / 2;
    return wide ? { x: m, y: c, w: cardMain, h: cardCross } : { x: c, y: m, w: cardCross, h: cardMain };
  });
  const colors = steps.map(accent);
  const wires = rects.slice(1).map((r, i) => {
    const a = rects[i];
    const ax = a.x + a.w / 2, ay = a.y + a.h / 2, bx = r.x + r.w / 2, by = r.y + r.h / 2;
    const sameLine = wide ? Math.abs(ay - by) < 1 : Math.abs(ax - bx) < 1;
    if (sameLine) {
      return wide
        ? `M${bx > ax ? a.x + a.w + 4 : a.x - 4} ${ay} L${bx > ax ? r.x - 6 : r.x + r.w + 6} ${by}`
        : `M${ax} ${by > ay ? a.y + a.h + 4 : a.y - 4} L${bx} ${by > ay ? r.y - 6 : r.y + r.h + 6}`;
    }
    // Turning to the next line: a smooth U around the end.
    return wide
      ? `M${ax} ${a.y + a.h + 4} C${ax} ${a.y + a.h + gapCross * 0.9}, ${bx} ${r.y - gapCross * 0.9}, ${bx} ${r.y - 6}`
      : `M${a.x + a.w + 4} ${ay} C${a.x + a.w + gapCross * 0.9} ${ay}, ${r.x - gapCross * 0.9} ${by}, ${r.x - 6} ${by}`;
  });
  return (
    <>
      <svg className="dg-svg" width={b.W} height={b.H}><Defs colors={colors} />{wires.map((d, i) => <Wire key={i} d={d} color={colors[i + 1]} />)}</svg>
      {steps.map((s, i) => <Node key={i} it={s} color={colors[i]} n={i + 1} delay={i * 70} style={{ left: rects[i].x, top: rects[i].y, width: rects[i].w, height: rects[i].h }} />)}
    </>
  );
}

// ---- sequence: actors across, messages spaced down the height ----
function Sequence({ b, actors, messages }: { b: Box; actors?: string[]; messages: { from: string; to: string; text: string; reply?: boolean; tone?: Tone }[] }) {
  const names = actors?.length ? actors : [...new Set(messages.flatMap((m) => [m.from, m.to]))];
  const col = b.W / Math.max(names.length, 1);
  const x = (a: string) => col * Math.max(0, names.indexOf(a)) + col / 2;
  const headH = clamp(b.s * 3.2, 34, 56);
  const rows = Math.max(messages.length, 1);
  const rowH = clamp((b.H - headH * 1.6) / rows, b.s * 2.6, b.s * 7);
  const H = Math.max(b.H, headH * 1.6 + rowH * rows);
  const colors = names.map((_, i) => PALETTE[i % PALETTE.length]);
  const colorOf = (a: string, m?: { tone?: Tone }) => (m?.tone && TONES[m.tone]) || colors[Math.max(0, names.indexOf(a))];
  return (
    <div style={{ position: 'relative', width: b.W, height: H }}>
      <svg className="dg-svg" width={b.W} height={H}>
        <Defs colors={[...colors, ...Object.values(TONES)]} />
        {names.map((a, i) => <line key={a} className="dg-life" style={acc(colors[i])} x1={x(a)} x2={x(a)} y1={headH} y2={H - 4} />)}
        {messages.map((m, i) => {
          const y = headH * 1.35 + rowH * (i + 0.6), a = x(m.from), c = x(m.to), color = colorOf(m.from, m);
          if (m.from === m.to) return <Wire key={i} d={`M${a} ${y - rowH * 0.2} h${col * 0.28} v${rowH * 0.4} h${-col * 0.28 + 6}`} color={color} dashed={m.reply} />;
          return <Wire key={i} d={`M${a + (c > a ? 4 : -4)} ${y} L${c + (c > a ? -8 : 8)} ${y}`} color={color} dashed={m.reply} />;
        })}
      </svg>
      {names.map((a, i) => (
        <div key={a} className="dg-actor" style={acc(colors[i], { left: x(a), top: 0, height: headH, maxWidth: col - b.s, animationDelay: `${i * 60}ms` })}>{a}</div>
      ))}
      {messages.map((m, i) => {
        const y = headH * 1.35 + rowH * (i + 0.6), a = x(m.from), c = x(m.to), self = m.from === m.to;
        return (
          <div key={i} className={`dg-say${m.reply ? ' reply' : ''}`} style={acc(colorOf(m.from, m), {
            left: self ? a + col * 0.32 : Math.min(a, c) + Math.abs(c - a) / 2, top: y, maxWidth: self ? col * 0.6 : Math.max(Math.abs(c - a) - b.s, b.s * 6),
            transform: self ? 'translate(0, -50%)' : 'translate(-50%, calc(-100% - 5px))', animationDelay: `${200 + i * 90}ms`,
          })}>{m.text}</div>
        );
      })}
    </div>
  );
}

// ---- layers: bands filling the height, each with its own hue ----
function Layers({ b, layers }: { b: Box; layers: Item[] }) {
  const n = Math.max(layers.length, 1), gap = clamp(b.s * 0.8, 6, 14);
  const bandH = (b.H - gap * (n - 1)) / n;
  const narrow = b.W < b.s * 34;
  return (
    <div className="dg-layers" style={{ gap }}>
      {layers.map((l, i) => {
        const c = accent(l, i);
        return (
          <section key={i} className={`dg-band${narrow ? ' narrow' : ''}`} style={acc(c, { height: bandH, animationDelay: `${i * 80}ms` })}>
            <header style={{ width: narrow ? undefined : clamp(b.W * 0.24, b.s * 8, b.s * 16) }}><b>{l.title}</b>{l.note && <small>{l.note}</small>}</header>
            <div className="dg-chips">
              {(l.items ?? []).map((x: any, j: number) => { const it = item(x); return <span key={j} className="dg-chip" style={it.tone ? acc(TONES[it.tone]) : undefined} title={it.note}>{it.title}</span>; })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

// ---- timeline: an axis across (wide) or down (tall), events alternating either side ----
function Timeline({ b, events }: { b: Box; events: Item[] }) {
  const n = Math.max(events.length, 1);
  const wide = b.W / b.H >= 0.9;
  const along = wide ? b.W : b.H, across = wide ? b.H : b.W;
  const slot = along / n;
  const cardAlong = clamp(slot * (wide ? 1.55 : 1), b.s * 8, b.s * (wide ? 15 : 20));
  const cardAcross = clamp(across * (wide ? 0.26 : 0.36), b.s * 4.2, b.s * (wide ? 6.5 : 7));
  const mid = across / 2;
  const pos = (i: number) => slot * (i + 0.5);
  const colors = events.map(accent);
  const axis = wide ? `M0 ${mid} L${b.W} ${mid}` : `M${mid} 0 L${mid} ${b.H}`;
  return (
    <>
      <svg className="dg-svg" width={b.W} height={b.H}>
        {/* userSpaceOnUse: a straight line has no height, so a bounding-box gradient wouldn't draw */}
        <defs><linearGradient id="tl-axis" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2={wide ? b.W : 0} y2={wide ? 0 : b.H}>{colors.map((c, i) => <stop key={i} offset={`${((i + 0.5) / n) * 100}%`} style={{ stopColor: c }} />)}</linearGradient></defs>
        <path d={axis} className="dg-axis" stroke="url(#tl-axis)" />
        {events.map((_, i) => {
          const p = pos(i), side = i % 2 ? 1 : -1, stem = cardAcross * 0.25 + b.s;
          return <path key={i} className="dg-stem" style={acc(colors[i])} d={wide ? `M${p} ${mid} L${p} ${mid + side * stem}` : `M${mid} ${p} L${mid + side * stem} ${p}`} />;
        })}
      </svg>
      {events.map((e, i) => {
        const p = pos(i), side = i % 2 ? 1 : -1, off = cardAcross * 0.25 + b.s;
        const lo = clamp(p - cardAlong / 2, 0, along - cardAlong);
        const style: CSSProperties = wide
          ? { left: lo, width: cardAlong, top: side < 0 ? mid - off - cardAcross : mid + off, height: cardAcross }
          : { top: clamp(p - cardAcross / 2, 0, b.H - cardAcross), height: cardAcross, left: side < 0 ? Math.max(0, mid - off - cardAlong) : mid + off, width: Math.min(cardAlong, mid - off) };
        return (
          <Fragment key={i}>
            <span className="dg-dot" style={acc(colors[i], wide ? { left: p, top: mid } : { left: mid, top: p })} />
            <div className="dg-node dg-event" style={acc(colors[i], { ...style, animationDelay: `${i * 80}ms` })}>
              {e.when && <span className="dg-when">{e.when}</span>}
              <b>{e.title}</b>
              {e.note && <small>{e.note}</small>}
            </div>
          </Fragment>
        );
      })}
    </>
  );
}
const Fragment = ({ children }: { children: ReactNode }) => <>{children}</>;

// ---- compare: columns side by side (stacked when narrow), filling the height ----
function Compare({ b, columns }: { b: Box; columns: Item[] }) {
  const n = Math.max(columns.length, 1);
  const most = Math.max(1, ...columns.map((c) => (c.points ?? []).length));
  // Columns need room for the longest list; when the window is short (or the columns too thin),
  // each option becomes a row with its points as chips, and type shrinks a little if still tight.
  const colsFit = b.W / n >= b.s * 11 && b.H >= b.s * (5.5 + most * 3.2);
  if (!colsFit && b.W >= b.s * 30) {
    const rowH = (b.H - b.s * (n - 1)) / n;
    const fs = clamp(rowH / (b.s * 4.2), 0.72, 1);
    return (
      <div className="dg-compare rows" style={{ gridAutoRows: '1fr', gap: b.s * 0.8, fontSize: `${fs}em` }}>
        {columns.map((c, i) => {
          const color = accent(c, i);
          return (
            <section key={i} className={`dg-col dg-row${c.tone === 'good' ? ' pick' : ''}`} style={acc(color, { animationDelay: `${i * 70}ms` })}>
              <header style={{ width: clamp(b.W * 0.22, b.s * 8, b.s * 15) }}><b>{c.title}</b>{c.tone === 'good' && <span className="dg-ribbon">best fit</span>}{c.note && <small>{c.note}</small>}</header>
              <div className="dg-chips">
                {(c.points ?? []).map((p: any, j: number) => {
                  const it = item(p), bad = it.tone === 'bad' || it.tone === 'warn';
                  return <span key={j} className="dg-chip dg-point" style={it.tone ? acc(TONES[it.tone]) : undefined} title={it.note}><i>{bad ? '–' : '✓'}</i>{it.title}</span>;
                })}
              </div>
            </section>
          );
        })}
      </div>
    );
  }
  const stacked = b.W / n < b.s * 11;
  return (
    <div className={`dg-compare${stacked ? ' stacked' : ''}`} style={{ gridTemplateColumns: stacked ? '1fr' : `repeat(${n}, 1fr)` }}>
      {columns.map((c, i) => {
        const color = accent(c, i);
        return (
          <section key={i} className={`dg-col${c.tone === 'good' ? ' pick' : ''}`} style={acc(color, { animationDelay: `${i * 90}ms` })}>
            <header>{c.tone === 'good' && <span className="dg-ribbon">best fit</span>}<b>{c.title}</b>{c.note && <small>{c.note}</small>}</header>
            <ul>
              {(c.points ?? []).map((p: any, j: number) => {
                const it = item(p), bad = it.tone === 'bad' || it.tone === 'warn';
                return <li key={j} style={it.tone ? acc(TONES[it.tone]) : undefined}><i>{bad ? '–' : '✓'}</i><span>{it.title}{it.note && <small>{it.note}</small>}</span></li>;
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

// ---- tree: a tidy layout that fits the box; top-down or left-to-right, whichever fits the shape ----
interface TNode { it: Item; kids: TNode[]; depth: number; leaf0: number; leaves: number }
function Tree({ b, root }: { b: Box; root: Item }) {
  let leafCount = 0, depthMax = 0;
  const build = (it: Item, depth: number): TNode => {
    depthMax = Math.max(depthMax, depth);
    const kids = (it.children ?? []).map((c: any) => build(item(c), depth + 1));
    const leaf0 = kids.length ? kids[0].leaf0 : leafCount++;
    return { it, kids, depth, leaf0, leaves: kids.length ? kids.reduce((t: number, k: TNode) => t + k.leaves, 0) : 1 };
  };
  const t = build(root, 0);
  const levels = depthMax + 1;
  // Orientation: whichever makes the cells closest to a card's shape.
  const down = Math.abs(Math.log((b.W / leafCount) / (b.H / levels) / 2.2)) <= Math.abs(Math.log((b.W / levels) / (b.H / leafCount) / 2.2));
  const breadth = down ? b.W : b.H, depth = down ? b.H : b.W;
  const cellB = breadth / leafCount, cellD = depth / levels;
  const nodeB = clamp(cellB * 0.86, b.s * 5, b.s * 16), nodeD = clamp(cellD * (down ? 0.42 : 0.72), b.s * 2.6, b.s * (down ? 5 : 14));
  const all: { n: TNode; cb: number; cd: number; parent?: { cb: number; cd: number }; idx: number }[] = [];
  const walk = (n: TNode, parent?: { cb: number; cd: number }) => {
    const cb = (n.leaf0 + n.leaves / 2) * cellB, cd = (n.depth + 0.5) * cellD;
    all.push({ n, cb, cd, parent, idx: all.length });
    n.kids.forEach((k) => walk(k, { cb, cd }));
  };
  walk(t);
  const xy = (cb: number, cd: number) => (down ? [cb, cd] : [cd, cb]);
  const colorOf = (n: TNode, i: number) => (n.it.tone && TONES[n.it.tone]) || PALETTE[n.depth % PALETTE.length] || PALETTE[i % PALETTE.length];
  return (
    <>
      <svg className="dg-svg" width={b.W} height={b.H}>
        {all.filter((a) => a.parent).map((a) => {
          const [px, py] = xy(a.parent!.cb, a.parent!.cd + (down ? nodeD / 2 : nodeB / 2));
          const [cx, cy] = xy(a.cb, a.cd - (down ? nodeD / 2 : nodeB / 2));
          const d = down ? `M${px} ${py} C${px} ${(py + cy) / 2}, ${cx} ${(py + cy) / 2}, ${cx} ${cy}` : `M${px} ${py} C${(px + cx) / 2} ${py}, ${(px + cx) / 2} ${cy}, ${cx} ${cy}`;
          return <Wire key={a.idx} d={d} color={colorOf(a.n, a.idx)} arrow={false} />;
        })}
      </svg>
      {all.map((a) => {
        const [x, y] = xy(a.cb, a.cd);
        const w = down ? nodeB : clamp(cellD * 0.72, b.s * 6, b.s * 14), h = down ? nodeD : clamp(cellB * 0.7, b.s * 2.6, b.s * 5);
        return <Node key={a.idx} it={a.n.it} color={colorOf(a.n, a.idx)} className={a.n.depth === 0 ? 'root' : ''} delay={a.n.depth * 90 + a.idx * 15} style={{ left: x - w / 2, top: y - h / 2, width: w, height: h }} />;
      })}
    </>
  );
}

// ---- cycle: steps around a ring that fills the box, arcs between them ----
function Cycle({ b, steps, center }: { b: Box; steps: Item[]; center?: string }) {
  const n = Math.max(steps.length, 1);
  const cardW = clamp(Math.min(b.W, b.H) * 0.26, b.s * 7, b.s * 14), cardH = clamp(cardW * 0.42, b.s * 2.8, b.s * 6);
  const rx = Math.max(b.W / 2 - cardW / 2 - b.s, b.s * 6), ry = Math.max(b.H / 2 - cardH / 2 - b.s, b.s * 5);
  const cx = b.W / 2, cy = b.H / 2;
  const at = (k: number) => { const a = (k / n) * Math.PI * 2 - Math.PI / 2; return [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]; };
  const colors = steps.map(accent);
  // Arcs from each step to the next along the ellipse, trimmed so they start and end outside the cards.
  const arcs = steps.map((_, i) => {
    const pts: string[] = [];
    const t0 = i + 0.24, t1 = i + 0.76;
    for (let k = 0; k <= 16; k++) { const [x, y] = at(t0 + ((t1 - t0) * k) / 16); pts.push(`${k ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`); }
    return pts.join(' ');
  });
  return (
    <>
      <svg className="dg-svg" width={b.W} height={b.H}>
        <Defs colors={colors} />
        <ellipse cx={cx} cy={cy} rx={rx} ry={ry} className="dg-ring" />
        {arcs.map((d, i) => <Wire key={i} d={d} color={colors[(i + 1) % n]} />)}
      </svg>
      {center && <div className="dg-center" style={{ left: cx, top: cy, maxWidth: rx * 1.2, fontSize: clamp(Math.min(rx, ry) / 6, 13, 26) }}>{center}</div>}
      {steps.map((s, i) => { const [x, y] = at(i); return <Node key={i} it={s} color={colors[i]} n={i + 1} delay={i * 80} style={{ left: x - cardW / 2, top: y - cardH / 2, width: cardW, height: cardH }} />; })}
    </>
  );
}

// ---- stats: tiles arranged to fill the box; numbers scale with the tile ----
function Stats({ b, items }: { b: Box; items: Item[] }) {
  const n = Math.max(items.length, 1), gap = clamp(b.s * 1, 8, 16);
  // Pick the column count whose tiles come closest to a 1.5:1 card.
  let best = 1, score = Infinity;
  for (let c = 1; c <= n; c++) {
    const r = Math.ceil(n / c), w = (b.W - gap * (c - 1)) / c, h = (b.H - gap * (r - 1)) / r;
    const s = Math.abs(Math.log(w / h / 1.5)) + (c * r - n) * 0.7; // empty cells look unfinished
    if (s < score) { score = s; best = c; }
  }
  const rows = Math.ceil(n / best);
  const tileW = (b.W - gap * (best - 1)) / best, tileH = Math.min((b.H - gap * (rows - 1)) / rows, tileW * 1.1);
  const big = clamp(Math.min(tileW / 5, tileH / 2.8), 18, 96);
  return (
    <div className="dg-stats" style={{ gridTemplateColumns: `repeat(${best}, 1fr)`, gridAutoRows: tileH, gap, alignContent: 'center', height: b.H }}>
      {items.map((s, i) => {
        const c = accent(s, i);
        const delta = String(s.delta ?? '');
        const down = /^[-−–]/.test(delta);
        return (
          <div key={i} className="dg-stat" style={acc(c, { animationDelay: `${i * 80}ms` })}>
            <span className="dg-stat-label" style={{ fontSize: clamp(big * 0.22, 10, 15) }}>{s.label ?? s.title}</span>
            <span className="dg-stat-value" style={{ fontSize: big }}>{s.value}</span>
            {delta && <span className={`dg-delta${down ? ' down' : ''}`} style={{ fontSize: clamp(big * 0.24, 11, 18) }}>{down ? '▼' : '▲'} {delta.replace(/^[-−–+]/, '')}</span>}
            {Array.isArray(s.trend) && s.trend.length > 1 && <Spark values={s.trend.map(Number)} />}
            {s.note && <small>{s.note}</small>}
          </div>
        );
      })}
    </div>
  );
}
function Spark({ values }: { values: number[] }) {
  const lo = Math.min(...values), hi = Math.max(...values), span = hi - lo || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${30 - ((v - lo) / span) * 26 - 2}`).join(' ');
  return <svg className="dg-spark" viewBox="0 0 100 30" preserveAspectRatio="none"><polyline points={pts} /></svg>;
}
