import { type AppDef, type Args, str, unknownCommand } from '../types';

export interface HtmlState {
  html: string;
  updatedAt: number;
}

export const html: AppDef<HtmlState> = {
  type: 'html',
  title: 'Canvas',
  icon: '◇',
  singleton: false,
  description: 'Freeform HTML/CSS/JS you write, rendered in a sandboxed iframe. Use for diagrams, charts, mockups, custom widgets.',
  commands: {
    render: { usage: 'render --text <html> | --file <path>', help: 'Replace the rendered HTML document' },
    clear: { usage: 'clear', help: 'Blank the canvas' },
  },
  init: () => ({ html: '', updatedAt: 0 }),
  command(_s, cmd, a: Args) {
    switch (cmd) {
      case 'render':
        return { html: str(a, 'text').slice(0, 2_000_000), updatedAt: Date.now() };
      case 'clear':
        return html.init();
      default:
        return unknownCommand('html', cmd);
    }
  },
};
