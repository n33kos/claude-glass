import { fileUrl, type ViewProps } from '../../renderer/viewTypes';
import type { ImageState } from './index';

export function ImageView({ state, run }: ViewProps<ImageState>) {
  const n = state.images.length;
  if (!n) return <div className="img-empty">Images Claude looks at or shows you appear here.</div>;
  const idx = state.index < 0 || state.index >= n ? n - 1 : state.index;
  const img = state.images[idx];
  const go = (i: number) => run('select', { index: i === n - 1 ? -1 : i });
  return (
    <div className="imageview">
      <figure>
        <img src={fileUrl(img.file)} alt={img.caption ?? img.name} draggable={false} />
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
