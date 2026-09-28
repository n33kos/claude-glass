import { type AppDef, type Args, str, unknownCommand } from '../types';

// Diagrams from templates: Claude picks a template and fills it with data; the view draws it the
// same polished way every time. Deterministic, cheap for Claude, and consistent in look.
export const TEMPLATES = ['flow', 'sequence', 'layers', 'timeline', 'compare', 'tree', 'cycle', 'stats'] as const;
export type Template = (typeof TEMPLATES)[number];
export type Tone = 'good' | 'bad' | 'warn' | 'info' | 'muted';

export interface DiagramState { template?: Template; title?: string; data?: any; updatedAt: number }

/** What each template needs; checked so a bad call fails with a useful message instead of a blank view. */
const NEEDS: Record<Template, [string, string]> = {
  flow: ['steps', '{"steps":[{"title":"Parse","note":"optional","tone":"info"}]}'],
  sequence: ['messages', '{"actors":["CLI","Glass"],"messages":[{"from":"CLI","to":"Glass","text":"open"},{"from":"Glass","to":"CLI","text":"ok","reply":true}]}'],
  layers: ['layers', '{"layers":[{"title":"UI","items":["Dock","Windows"]},{"title":"Core","items":["Reducer"]}]}'],
  timeline: ['events', '{"events":[{"when":"10:02","title":"Bug reported","tone":"bad"}]}'],
  compare: ['columns', '{"columns":[{"title":"Option A","points":["Fast","Simple"],"tone":"good"},{"title":"Option B","points":["Flexible"]}]}'],
  tree: ['root', '{"root":{"title":"App","children":[{"title":"Core"},{"title":"UI","children":[{"title":"Dock"}]}]}}'],
  cycle: ['steps', '{"steps":[{"title":"Plan"},{"title":"Build"},{"title":"Test"}]}'],
  stats: ['items', '{"items":[{"label":"Renders","value":"2","delta":"-96%","tone":"good"}]}'],
};

export const diagram: AppDef<DiagramState> = {
  type: 'diagram',
  title: 'Diagram',
  icon: '◈',
  singleton: false,
  description: `Polished diagrams from templates (${TEMPLATES.join(', ')}): pick one and give it data as JSON.`,
  commands: {
    show: { usage: `show --template <${TEMPLATES.join('|')}> --data <json> | --data-file <path> [--title T]`, help: 'Draw a diagram (see the guide for each template\'s data)' },
    clear: { usage: 'clear', help: 'Empty the diagram' },
  },
  init: () => ({ updatedAt: 0 }),
  command(s, cmd, a: Args) {
    switch (cmd) {
      case 'show': {
        const template = str(a, 'template') as Template;
        if (!TEMPLATES.includes(template)) throw new Error(`diagram: unknown template "${template}" (${TEMPLATES.join(', ')})`);
        let data: any;
        try { data = typeof a.data === 'string' ? JSON.parse(a.data) : a.data; } catch (e) { throw new Error(`diagram: --data isn't valid JSON (${(e as Error).message})`); }
        const [key, example] = NEEDS[template];
        if (!data || typeof data !== 'object' || data[key] == null) throw new Error(`diagram: the ${template} template needs "${key}", e.g. ${example}`);
        return { template, data, title: a.title ? String(a.title) : data.title, updatedAt: Date.now() };
      }
      case 'clear': return diagram.init();
      default: return unknownCommand('diagram', cmd);
    }
  },
};

export default diagram;
