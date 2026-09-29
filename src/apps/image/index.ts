import { type AppDef, type Args, capTail, str, unknownCommand } from '../types';

export interface ImageItem {
  file: string; // absolute path of the copy inside the session files dir
  name: string; // original file name
  source?: string; // where the original was, for "Show in Finder"
  caption?: string;
  at: number;
}

export interface ImageState {
  images: ImageItem[];
  index: number; // currently shown; -1 = latest
  view?: 'single' | 'grid'; // grid: the most recent images at once (absent = single)
  source?: 'shown' | 'project'; // what's listed: images shown here, or the project folder's (absent = shown if any)
}

export const GRID_MAX = 12;

export const image: AppDef<ImageState> = {
  type: 'image',
  title: 'Images',
  icon: '▣',
  singleton: false,
  description: 'The one image viewer: every image Claude reads or shows lands in the "images" window (flip through them, or a grid), and a Project list shows the images in the project folder.',
  commands: {
    add: { usage: 'add --file <path> [--caption <text>]', help: 'Show an image (it is copied into the session)' },
    select: { usage: 'select --index <n>', help: 'Show image n (0-based, -1 = latest)', view: true },
    view: { usage: 'view [--mode single|grid] [--source shown|project]', help: 'One image at a time or a grid of the most recent; images shown here or the project folder\'s', view: true },
    clear: { usage: 'clear', help: 'Remove all images' },
  },
  settings: {
    gridSize: { type: 'number', label: 'Images in the grid view', help: 'How many recent images the grid shows', default: GRID_MAX, min: 2, max: 40 },
  },
  init: () => ({ images: [], index: -1 }),
  command(s, cmd, a: Args) {
    switch (cmd) {
      case 'add':
        return {
          ...s,
          images: capTail([...s.images, { file: str(a, 'file'), name: String(a.name ?? str(a, 'file').split('/').pop()), ...(a.source ? { source: String(a.source) } : {}), caption: a.caption ? String(a.caption) : undefined, at: Date.now() }], 200),
          index: -1,
          source: 'shown', // a new image is what to look at
        };
      case 'select':
        return { ...s, index: Number(a.index ?? -1), view: a.single ? 'single' : s.view, source: 'shown' };
      case 'view': {
        const mode = a.mode == null ? s.view : String(a.mode);
        const source = a.source == null ? s.source : String(a.source);
        if (mode != null && mode !== 'single' && mode !== 'grid') throw new Error('image: view --mode single|grid');
        if (source != null && source !== 'shown' && source !== 'project') throw new Error('image: view --source shown|project');
        if (a.mode == null && a.source == null) throw new Error('image: view --mode single|grid and/or --source shown|project');
        return { ...s, view: mode as ImageState['view'], source: source as ImageState['source'] };
      }
      case 'clear':
        return image.init();
      default:
        return unknownCommand('image', cmd);
    }
  },
};

export default image;
