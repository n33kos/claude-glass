import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/** Full-window overlay: wheel/pinch zooms toward the cursor, drag pans, Esc or backdrop closes.
 *  Pure view state, nothing reaches the reducer. */
export function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const [t, setT] = useState({ scale: 1, x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  // Take focus (it may sit inside an app's frame) so Esc reaches us.
  useEffect(() => { box.current?.focus(); }, []);

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
    <div className="lightbox" ref={box} tabIndex={-1} onWheel={onWheel}
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
