import { type AppDef, type Args, str, unknownCommand } from '../types';

export interface MarkdownState {
  content: string;
  source?: string;
  updatedAt: number;
}

const MAX = 500_000;

export const markdown: AppDef<MarkdownState> = {
  type: 'markdown',
  title: 'Notes',
  icon: '¶',
  singleton: false,
  description: 'Rendered markdown: plans, notes, summaries, tables. Plans land in the "plan" instance automatically.',
  commands: {
    set: { usage: 'set --text <markdown> | --file <path>', help: 'Replace the content' },
    append: { usage: 'append --text <markdown> | --file <path>', help: 'Append to the content' },
    clear: { usage: 'clear', help: 'Empty the viewer' },
  },
  init: () => ({ content: '', updatedAt: 0 }),
  command(s, cmd, a: Args) {
    switch (cmd) {
      case 'set':
        return { content: str(a, 'text').slice(0, MAX), source: a.source ? String(a.source) : undefined, updatedAt: Date.now() };
      case 'append':
        return { ...s, content: (s.content + (s.content ? '\n\n' : '') + str(a, 'text')).slice(-MAX), updatedAt: Date.now() };
      case 'clear':
        return markdown.init();
      default:
        return unknownCommand('markdown', cmd);
    }
  },
};
