import { type AppDef, type Args, capTail, str, unknownCommand } from '../types';

export interface ImageItem {
  file: string; // absolute path of the copy inside the session files dir
  name: string; // original file name
  caption?: string;
  at: number;
}

export interface ImageState {
  images: ImageItem[];
  index: number; // currently shown; -1 = latest
  view?: 'single' | 'grid'; // grid: the most recent images at once (absent = single)
}

export const GRID_MAX = 12;

export const image: AppDef<ImageState> = {
  type: 'image',
  title: 'Images',
  icon: '▣',
  singleton: false,
  description: 'Image viewer with history; flip left/right. Images Claude reads land in the "images" instance automatically.',
  commands: {
    add: { usage: 'add --file <path> [--caption <text>]', help: 'Show an image (it is copied into the session)' },
    select: { usage: 'select --index <n>', help: 'Show image n (0-based, -1 = latest)', view: true },
    view: { usage: 'view --mode single|grid', help: 'One image at a time, or a grid of the most recent', view: true },
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
          images: capTail([...s.images, { file: str(a, 'file'), name: String(a.name ?? str(a, 'file').split('/').pop()), caption: a.caption ? String(a.caption) : undefined, at: Date.now() }], 200),
          index: -1,
        };
      case 'select':
        return { ...s, index: Number(a.index ?? -1), view: a.single ? 'single' : s.view };
      case 'view': {
        const mode = String(a.mode ?? '');
        if (mode !== 'single' && mode !== 'grid') throw new Error('image: view --mode single|grid');
        return { ...s, view: mode };
      }
      case 'clear':
        return image.init();
      default:
        return unknownCommand('image', cmd);
    }
  },
};

export default image;
