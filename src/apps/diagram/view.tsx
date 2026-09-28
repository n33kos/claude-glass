import type { ReactNode } from 'react';
import type { AppViewProps } from '../../sdk/react';
import type { DiagramState, Tone } from './index';

// Each template turns plain data into the same polished drawing every time. Items accept
// `title`/`note`/`tone`; strings work wherever an item is expected.
type Item = { title?: string; note?: string; tone?: Tone; [k: string]: any };
const item = (v: any): Item => (typeof v === 'string' ? { title: v } : v ?? {});
const tone = (t?: Tone) => (t ? ` tone-${t}` : '');

export default function DiagramView({ state }: AppViewProps<DiagramState>) {
  if (!state.template) return <div className="dg-empty">Claude draws diagrams here from templates: flows, sequences, layers, timelines, comparisons, trees, cycles and stats.</div>;
  const d = state.data ?? {};
  const body: Record<string, () => ReactNode> = {
    flow: () => <Flow steps={(d.steps ?? []).map(item)} />,
    sequence: () => <Sequence actors={d.actors} messages={d.messages ?? []} />,
    layers: () => <Layers layers={(d.layers ?? []).map(item)} />,
    timeline: () => <Timeline events={(d.events ?? []).map(item)} />,
    compare: () => <Compare columns={(d.columns ?? []).map(item)} />,
    tree: () => <Tree root={item(d.root)} />,
    cycle: () => <Cycle steps={(d.steps ?? []).map(item)} />,
    stats: () => <Stats items={(d.items ?? []).map(item)} />,
  };
  return (
    <div className={`diagram dg-is-${state.template}`}>
      {state.title && <h2 className="dg-title">{state.title}</h2>}
      {body[state.template]?.()}
    </div>
  );
}

const Card = ({ it, n }: { it: Item; n?: number }) => (
  <div className={`dg-card${tone(it.tone)}`}>
    {n != null && <span className="dg-n">{n}</span>}
    <b>{it.title}</b>
    {it.note && <small>{it.note}</small>}
  </div>
);

function Flow({ steps }: { steps: Item[] }) {
  return (
    <div className="dg-flow">
      {steps.map((s, i) => (
        <div key={i} className="dg-flow-step">
          <Card it={s} n={i + 1} />
          {i < steps.length - 1 && <svg className="dg-arrow" viewBox="0 0 40 16" aria-hidden><path d="M2 8h32m-7-6 7 6-7 6" /></svg>}
        </div>
      ))}
    </div>
  );
}

function Sequence({ actors, messages }: { actors?: string[]; messages: { from: string; to: string; text: string; reply?: boolean; tone?: Tone }[] }) {
  const names = actors?.length ? actors : [...new Set(messages.flatMap((m) => [m.from, m.to]))];
  const col = 100 / names.length, x = (a: string) => col * names.indexOf(a) + col / 2;
  const ROW = 46, TOP = 56, h = TOP + messages.length * ROW + 24;
  return (
    <div className="dg-seq">
      <div className="dg-seq-heads">{names.map((a) => <div key={a} style={{ width: `${col}%` }}><span>{a}</span></div>)}</div>
      <svg viewBox={`0 0 100 ${h}`} preserveAspectRatio="none" style={{ height: h }} className="dg-seq-lines" aria-hidden>
        {names.map((a) => <line key={a} x1={x(a)} x2={x(a)} y1={0} y2={h} vectorEffect="non-scaling-stroke" />)}
      </svg>
      {messages.map((m, i) => {
        const a = x(m.from), b = x(m.to), left = Math.min(a, b), w = Math.abs(b - a), self = m.from === m.to;
        return (
          <div key={i} className={`dg-msg${m.reply ? ' reply' : ''}${tone(m.tone)}`} style={{ top: TOP - 30 + i * ROW, left: `${self ? a : left}%`, width: `${self ? col / 2 : w}%` }}>
            <span className="dg-msg-text">{m.text}</span>
            <span className={`dg-msg-line ${b >= a ? 'right' : 'left'}`} />
          </div>
        );
      })}
      <div style={{ height: h - 40 }} />
    </div>
  );
}

function Layers({ layers }: { layers: Item[] }) {
  return (
    <div className="dg-layers">
      {layers.map((l, i) => (
        <div key={i} className={`dg-layer${tone(l.tone)}`}>
          <div className="dg-layer-title"><b>{l.title}</b>{l.note && <small>{l.note}</small>}</div>
          <div className="dg-layer-items">{(l.items ?? []).map((x: any, j: number) => { const it = item(x); return <span key={j} className={`dg-chip${tone(it.tone)}`} title={it.note}>{it.title}</span>; })}</div>
        </div>
      ))}
    </div>
  );
}

function Timeline({ events }: { events: Item[] }) {
  return (
    <div className="dg-timeline">
      <div className="dg-tl-line" />
      {events.map((e, i) => (
        <div key={i} className={`dg-tl-event ${i % 2 ? 'below' : 'above'}${tone(e.tone)}`} style={{ left: `${events.length === 1 ? 50 : 4 + (i / (events.length - 1)) * 92}%` }}>
          <span className="dg-tl-dot" />
          <div className="dg-tl-card">
            {e.when && <span className="dg-when">{e.when}</span>}
            <b>{e.title}</b>
            {e.note && <small>{e.note}</small>}
          </div>
        </div>
      ))}
    </div>
  );
}

function Compare({ columns }: { columns: Item[] }) {
  return (
    <div className="dg-compare" style={{ gridTemplateColumns: `repeat(${Math.max(1, columns.length)}, 1fr)` }}>
      {columns.map((c, i) => (
        <section key={i} className={`dg-col${tone(c.tone)}`}>
          <header><b>{c.title}</b>{c.note && <small>{c.note}</small>}</header>
          <ul>{(c.points ?? []).map((p: any, j: number) => { const it = item(p); return <li key={j} className={tone(it.tone)}>{it.title}{it.note && <small>{it.note}</small>}</li>; })}</ul>
        </section>
      ))}
    </div>
  );
}

function Tree({ root }: { root: Item }) {
  const node = (n: Item, depth: number): ReactNode => (
    <li className={depth === 0 ? 'root' : ''}>
      <div className={`dg-node${tone(n.tone)}`}><b>{n.title}</b>{n.note && <small>{n.note}</small>}</div>
      {n.children?.length > 0 && <ul>{n.children.map((c: any, i: number) => <Frag key={i}>{node(item(c), depth + 1)}</Frag>)}</ul>}
    </li>
  );
  return <div className="dg-tree"><ul>{node(root, 0)}</ul></div>;
}
const Frag = ({ children }: { children: ReactNode }) => <>{children}</>;

function Cycle({ steps }: { steps: Item[] }) {
  const n = Math.max(steps.length, 1), R = 36;
  return (
    <div className="dg-cycle">
      <svg viewBox="-50 -50 100 100" className="dg-cycle-ring" aria-hidden>
        <circle r={R} />
        {steps.map((_, i) => {
          const a = ((i + 0.5) / n) * Math.PI * 2 - Math.PI / 2;
          const x = Math.cos(a) * R, y = Math.sin(a) * R, deg = (a * 180) / Math.PI + 90;
          return <path key={i} d="M-2.4 -2.2 L1.6 0 L-2.4 2.2" transform={`translate(${x} ${y}) rotate(${deg})`} />; // along the ring, clockwise
        })}
      </svg>
      {steps.map((s, i) => {
        const a = (i / n) * Math.PI * 2 - Math.PI / 2;
        return <div key={i} className="dg-cycle-step" style={{ left: `${50 + Math.cos(a) * R}%`, top: `${50 + Math.sin(a) * R}%` }}><Card it={s} n={i + 1} /></div>;
      })}
    </div>
  );
}

function Stats({ items }: { items: Item[] }) {
  return (
    <div className="dg-stats">
      {items.map((s, i) => (
        <div key={i} className={`dg-stat${tone(s.tone)}`}>
          <span className="dg-stat-label">{s.label ?? s.title}</span>
          <span className="dg-stat-value">{s.value}</span>
          {s.delta && <span className="dg-stat-delta">{s.delta}</span>}
          {s.note && <small>{s.note}</small>}
        </div>
      ))}
    </div>
  );
}
