import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { fileUrl, type ViewProps } from '../../renderer/viewTypes';
import type { ImageState } from './index';

export function ImageView({ state, run }: ViewProps<ImageState>) {
  const n = state.images.length;
  if (!n) return <div className="img-empty">Images Claude looks at or shows you appear here.</div>;
  const idx = state.index < 0 || state.index >= n ? n - 1 : state.index;
  const img = state.images[idx];
  const go = (i: number) => run('select', { index: i === n - 1 ? -1 : i });
  const [zoomed, setZoomed] = useState(false);
  return (
    <div className="imageview">
      {zoomed && <Lightbox src={fileUrl(img.file)} alt={img.caption ?? img.name} onClose={() => setZoomed(false)} />}
      <figure>
        <img src={fileUrl(img.file)} alt={img.caption ?? img.name} draggable={false} className="img-zoomable"
          title="Click to enlarge" onClick={() => setZoomed(true)} />
        <figcaption>
          {n > 1 && <button disabled={idx === 0} onClick={() => go(idx - 1)} aria-label="Previous image">‹</button>}
          <span className="img-name">{img.caption ?? img.name}</span>
          {n > 1 && <span className="img-count">{idx + 1} / {n}</span>}
          {n > 1 && <button disabled={idx === n - 1} onClick={() => go(idx + 1)} aria-label="Next image">›</button>}
        </figcaption>
      </figure>
    </div>
  );
}

/** Full-window overlay: wheel/pinch zooms toward the cursor, drag pans, Esc or backdrop closes.
 *  Pure view state, nothing reaches the reducer. */
function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const [t, setT] = useState({ scale: 1, x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const onWheel = (e: React.WheelEvent) => {
    // Trackpad pinch arrives as ctrl+wheel with small deltas; mouse wheels are coarser.
    const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
    setT((p) => {
      const scale = Math.min(20, Math.max(0.2, p.scale * factor));
      const k = scale / p.scale;
      // Keep the point under the cursor fixed (offsets are from the viewport center).
      const cx = e.clientX - window.innerWidth / 2, cy = e.clientY - window.innerHeight / 2;
      return { scale, x: cx - (cx - p.x) * k, y: cy - (cy - p.y) * k };
    });
  };

  return createPortal(
    <div className="lightbox" onWheel={onWheel}
      onPointerDown={(e) => { drag.current = { x: e.clientX, y: e.clientY, moved: false }; (e.target as Element).setPointerCapture?.(e.pointerId); }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.x, dy = e.clientY - d.y;
        if (!d.moved && Math.hypot(dx, dy) < 4) return;
        d.moved = true; d.x = e.clientX; d.y = e.clientY;
        setT((p) => ({ ...p, x: p.x + dx, y: p.y + dy }));
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        if (d && !d.moved && e.target === e.currentTarget) onClose(); // click on the backdrop
      }}>
      <img src={src} alt={alt} draggable={false} onDoubleClick={() => setT({ scale: 1, x: 0, y: 0 })}
        style={{ transform: `translate(${t.x}px, ${t.y}px) scale(${t.scale})` }} />
      <div className="lb-bar">
        <span>{alt}</span>
        <span className="lb-zoom">{Math.round(t.scale * 100)}%</span>
        <button onPointerDown={(e) => e.stopPropagation()} onClick={onClose} aria-label="Close">✕</button>
      </div>
    </div>,
    document.body,
  );
}
