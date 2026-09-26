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
}

export const image: AppDef<ImageState> = {
  type: 'image',
  title: 'Images',
  icon: '▣',
  singleton: false,
  description: 'Image viewer with history; flip left/right. Images Claude reads land in the "images" instance automatically.',
  commands: {
    add: { usage: 'add --file <path> [--caption <text>]', help: 'Show an image (it is copied into the session)' },
    select: { usage: 'select --index <n>', help: 'Show image n (0-based, -1 = latest)' },
    clear: { usage: 'clear', help: 'Remove all images' },
  },
  init: () => ({ images: [], index: -1 }),
  command(s, cmd, a: Args) {
    switch (cmd) {
      case 'add':
        return {
          images: capTail([...s.images, { file: str(a, 'file'), name: String(a.name ?? str(a, 'file').split('/').pop()), caption: a.caption ? String(a.caption) : undefined, at: Date.now() }], 200),
          index: -1,
        };
      case 'select':
        return { ...s, index: Number(a.index ?? -1) };
      case 'clear':
        return image.init();
      default:
        return unknownCommand('image', cmd);
    }
  },
};
