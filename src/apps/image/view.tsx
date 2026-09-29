import { useEffect, useState } from 'react';
import type { AppViewProps } from '../../sdk/react';
import { fileUrl } from '../../renderer/viewTypes';
import { GRID_MAX, type ImageState } from './index';

// A copy sized for how wide it's shown (the glass serves a cached thumbnail); the lightbox gets
// the original. Widths round up in the host, so resizing a window doesn't make a new copy each px.
const FOLDER_APP = /Win/i.test(navigator.platform) ? 'Explorer' : /Mac/i.test(navigator.platform) ? 'Finder' : 'folder';
const sized =(file: string, px: number) => `${fileUrl(file)}?w=${Math.round(px * (window.devicePixelRatio || 1))}`;

interface ProjectImage { path: string; rel: string; mtime: number }

/**
 * One viewer for every image: "Shown" (what Claude read or showed, one at a time or a grid) and
 * "Project" (the images in the project folder, newest first; asked of the glass when shown).
 */
export default function ImageView(props: AppViewProps<ImageState>) {
  const { state, run, ask } = props;
  const n = state.images.length;
  const source = state.source ?? (n ? 'shown' : 'project');
  const [project, setProject] = useState<ProjectImage[] | null>(null);
  const [scan, setScan] = useState(0);
  useEffect(() => {
    if (source !== 'project') return;
    let live = true;
    ask<{ images: ProjectImage[] }>('project-images').then((r) => { if (live) setProject(r.images); }).catch(() => { if (live) setProject([]); });
    return () => { live = false; };
  }, [source, scan]); // eslint-disable-line react-hooks/exhaustive-deps
  const grid = state.view === 'grid' && n > 1;
  return (
    <div className="img-app">
      <div className="img-bar">
        <div className="img-tabs" role="tablist">
          <button role="tab" aria-selected={source === 'shown'} className={source === 'shown' ? 'on' : ''} onClick={() => run('view', { source: 'shown' })}>
            Shown{n ? <span>{n}</span> : null}
          </button>
          <button role="tab" aria-selected={source === 'project'} className={source === 'project' ? 'on' : ''} onClick={() => run('view', { source: 'project' })}>
            Project{project?.length ? <span>{project.length}</span> : null}
          </button>
        </div>
        {source === 'project' && <button className="img-mode" title="Look again" aria-label="Refresh" onClick={() => setScan((x) => x + 1)}>↻</button>}
        {source === 'shown' && n > 1 && (
          <button className="img-mode" onClick={() => run('view', { mode: grid ? 'single' : 'grid' })}
            title={grid ? 'Show one at a time' : 'Show recent images as a grid'} aria-label={grid ? 'Single view' : 'Grid view'}>
            {grid ? '▢' : '▦'}
          </button>
        )}
      </div>
      {source === 'project' ? <Project {...props} list={project} /> : <Shown {...props} grid={grid} />}
    </div>
  );
}

function Project({ host, width, list }: AppViewProps<ImageState> & { list: ProjectImage[] | null }) {
  if (!list) return <div className="img-empty">Looking for images in the project…</div>;
  if (!list.length) return <div className="img-empty">No images in the project folder.</div>;
  return (
    <div className={`img-tiles ${list.length > 4 ? 'many' : `n${list.length}`}`}>
      {list.map((img) => (
        <button key={img.path} className="img-tile" title={img.rel}
          onClick={() => host('lightbox', { src: fileUrl(img.path), alt: img.rel })}>
          <img src={sized(img.path, Math.min(width, 480))} alt={img.rel} draggable={false} loading="lazy" />
          <span>{img.rel}</span>
        </button>
      ))}
    </div>
  );
}

function Shown({ state, run, host, settings, width, grid }: AppViewProps<ImageState> & { grid: boolean }) {
  const n = state.images.length;
  if (!n) return <div className="img-empty">Images Claude looks at or shows you appear here.</div>;

  if (grid) {
    // Newest first; click one to open it on its own.
    const recent = state.images.map((img, i) => ({ img, i })).slice(-(Number(settings?.gridSize) || GRID_MAX)).reverse();
    return (
      <div className={`img-tiles n${Math.min(recent.length, 4)}`}>
        {recent.map(({ img, i }) => (
          <button key={i} className="img-tile" title={img.caption ?? img.name}
            onClick={() => run('select', { index: i === n - 1 ? -1 : i, single: true })}>
            <img src={sized(img.file, Math.min(width, 480))} alt={img.caption ?? img.name} draggable={false} loading="lazy" />
            <span>{img.caption ?? img.name}</span>
          </button>
        ))}
      </div>
    );
  }

  const idx = state.index < 0 || state.index >= n ? n - 1 : state.index;
  const img = state.images[idx];
  const go = (i: number) => run('select', { index: i === n - 1 ? -1 : i });
  const src = fileUrl(img.file);
  return (
    <div className="imageview">
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
