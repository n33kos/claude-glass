import type { AppViewProps } from '../../sdk/react';
import { fileUrl } from '../../renderer/viewTypes';
import { GRID_MAX, type ImageState } from './index';

// A copy sized for how wide it's shown (the glass serves a cached thumbnail); the lightbox gets
// the original. Widths round up in the host, so resizing a window doesn't make a new copy each px.
const FOLDER_APP = /Win/i.test(navigator.platform) ? 'Explorer' : /Mac/i.test(navigator.platform) ? 'Finder' : 'folder';
const sized =(file: string, px: number) => `${fileUrl(file)}?w=${Math.round(px * (window.devicePixelRatio || 1))}`;

export default function ImageView({ state, run, host, settings, width }: AppViewProps<ImageState>) {
  const n = state.images.length;
  if (!n) return <div className="img-empty">Images Claude looks at or shows you appear here.</div>;
  const grid = state.view === 'grid' && n > 1;
  const toggle = n > 1 && (
    <button className="img-mode" onClick={() => run('view', { mode: grid ? 'single' : 'grid' })}
      title={grid ? 'Show one at a time' : 'Show recent images as a grid'} aria-label={grid ? 'Single view' : 'Grid view'}>
      {grid ? '▢' : '▦'}
    </button>
  );

  if (grid) {
    // Newest first; click one to open it on its own.
    const recent = state.images.map((img, i) => ({ img, i })).slice(-(Number(settings?.gridSize) || GRID_MAX)).reverse();
    return (
      <div className="imagegrid">
        {toggle}
        <div className={`img-tiles n${Math.min(recent.length, 4)}`}>
          {recent.map(({ img, i }) => (
            <button key={i} className="img-tile" title={img.caption ?? img.name}
              onClick={() => run('select', { index: i === n - 1 ? -1 : i, single: true })}>
              <img src={sized(img.file, Math.min(width, 480))} alt={img.caption ?? img.name} draggable={false} loading="lazy" />
              <span>{img.caption ?? img.name}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  const idx = state.index < 0 || state.index >= n ? n - 1 : state.index;
  const img = state.images[idx];
  const go = (i: number) => run('select', { index: i === n - 1 ? -1 : i });
  const src = fileUrl(img.file);
  return (
    <div className="imageview">
      {toggle}
      <figure>
        <img src={sized(img.file, width)} alt={img.caption ?? img.name} draggable={false} className="img-zoomable"
          title="Click to enlarge" onClick={() => host('lightbox', { src, alt: img.caption ?? img.name })} />
        <figcaption>
          {n > 1 && <button disabled={idx === 0} onClick={() => go(idx - 1)} aria-label="Previous image">‹</button>}
          <span className="img-name">{img.caption ?? img.name}</span>
          {n > 1 && <span className="img-count">{idx + 1} / {n}</span>}
          {n > 1 && <button disabled={idx === n - 1} onClick={() => go(idx + 1)} aria-label="Next image">›</button>}
          <button className="img-reveal" title={`Show in ${FOLDER_APP}`} aria-label={`Show in ${FOLDER_APP}`}
            onClick={() => host('reveal', { paths: [img.source, img.file].filter(Boolean) })}>{`Show in ${FOLDER_APP}`}</button>
        </figcaption>
      </figure>
    </div>
  );
}
