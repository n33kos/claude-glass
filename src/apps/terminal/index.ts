import { searchResults } from '../browser';
import { type AppDef, type Args, capTail, clip, str, unknownCommand } from '../types';

export interface TermEntry {
  id: string;
  kind: 'tool' | 'log' | 'agent';
  tool?: string;
  summary: string;
  output?: string;
  status: 'running' | 'ok' | 'error';
  at: number;
  durationMs?: number;
}

export interface TerminalState {
  entries: TermEntry[];
  hidden: string[]; // tool names filtered out of the view
}

const MAX_ENTRIES = 1000;
const MAX_OUTPUT = 4000;

const short = (s: unknown, n = 160) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

export function summarizeTool(tool: string, input: any): string {
  input = input ?? {};
  switch (tool) {
    case 'Bash': return `$ ${short(input.command, 400)}`;
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit': case 'NotebookEdit':
      return `${tool} ${input.file_path ?? input.notebook_path ?? ''}`;
    case 'Grep': return `Grep "${short(input.pattern, 80)}"${input.path ? ' in ' + input.path : ''}`;
    case 'Glob': return `Glob ${input.pattern ?? ''}${input.path ? ' in ' + input.path : ''}`;
    case 'WebFetch': return `WebFetch ${input.url ?? ''}`;
    case 'WebSearch': return `WebSearch "${short(input.query, 100)}"`;
    case 'Task': case 'Agent': return `${tool} ${short(input.description ?? input.prompt, 120)}`;
    case 'TodoWrite': return `TodoWrite (${Array.isArray(input.todos) ? input.todos.length : 0} items)`;
    case 'AskUserQuestion': return `AskUserQuestion "${short(input.questions?.[0]?.question, 140)}"`;
    default: return `${tool} ${short(JSON.stringify(input), 140)}`;
  }
}

export function summarizeOutput(tool: string, response: any): string {
  if (response == null) return '';
  if (typeof response === 'string') return clip(response, MAX_OUTPUT);
  switch (tool) {
    case 'Bash': {
      const out = [response.stdout, response.stderr].filter(Boolean).join('\n');
      return clip(out, MAX_OUTPUT);
    }
    case 'Read': {
      const f = response.file;
      if (f?.numLines != null) return `${f.numLines} lines`;
      return response.type === 'image' ? 'image' : '';
    }
    case 'Edit': case 'MultiEdit': case 'Write': {
      const hunks: any[] = response.structuredPatch ?? [];
      let add = 0, del = 0;
      for (const h of hunks) for (const l of h.lines ?? []) {
        if (l.startsWith('+')) add++; else if (l.startsWith('-')) del++;
      }
      if (!hunks.length && response.type === 'create') return 'created';
      return `+${add} −${del}`;
    }
    case 'WebSearch': {
      const results = searchResults(response);
      return clip([`${results.length} result${results.length === 1 ? '' : 's'}`, ...results.map((r) => `${r.title}  ${r.url}`)].join('\n'), MAX_OUTPUT);
    }
    case 'WebFetch': {
      const head = [response.code && `${response.code} ${response.codeText ?? ''}`.trim(), response.bytes != null && `${(response.bytes / 1024).toFixed(1)} KB`].filter(Boolean).join(' · ');
      return clip([head, typeof response.result === 'string' ? response.result : ''].filter(Boolean).join('\n'), MAX_OUTPUT);
    }
    case 'Grep': case 'Glob': {
      if (typeof response.content === 'string' && response.content) return clip(response.content, MAX_OUTPUT);
      if (Array.isArray(response.filenames)) {
        const n = response.numFiles ?? response.filenames.length;
        return clip([`${n} file${n === 1 ? '' : 's'}`, ...response.filenames.slice(0, 20)].join('\n'), MAX_OUTPUT);
      }
      return '';
    }
    default: {
      const text = typeof response.content === 'string' ? response.content
        : typeof response.output === 'string' ? response.output
        : JSON.stringify(response);
      return clip(text, 1200);
    }
  }
}

function upsert(entries: TermEntry[], e: TermEntry): TermEntry[] {
  const i = entries.findIndex((x) => x.id === e.id);
  if (i === -1) return capTail([...entries, e], MAX_ENTRIES);
  const next = entries.slice();
  next[i] = { ...entries[i], ...e, summary: entries[i].summary || e.summary, at: entries[i].at };
  return next;
}

export const terminal: AppDef<TerminalState> = {
  type: 'terminal',
  title: 'Terminal',
  icon: '❯',
  singleton: true,
  viewCommands: ['filter'],
  description: 'Every tool call Claude makes, shown as terminal activity. Filled automatically by hooks.',
  commands: {
    log: { usage: 'log --text <line>', help: 'Print a line of your own into the terminal' },
    clear: { usage: 'clear', help: 'Clear the terminal' },
  },
  init: () => ({ entries: [], hidden: [] }),
  command(s, cmd, a: Args) {
    switch (cmd) {
      case 'tool.start':
        // Hooks run async; a late start must not reset a finished entry.
        if (s.entries.some((e) => e.id === a.id)) return s;
        return { ...s, entries: upsert(s.entries, {
          id: str(a, 'id'), kind: 'tool', tool: str(a, 'tool'),
          summary: summarizeTool(str(a, 'tool'), a.input), status: 'running', at: Number(a.at ?? Date.now()),
        }) };
      case 'tool.end': {
        const tool = str(a, 'tool');
        return { ...s, entries: upsert(s.entries, {
          id: str(a, 'id'), kind: 'tool', tool, summary: summarizeTool(tool, a.input),
          output: summarizeOutput(tool, a.response), status: a.error ? 'error' : 'ok',
          at: Number(a.at ?? Date.now()), durationMs: a.durationMs == null ? undefined : Number(a.durationMs),
        }) };
      }
      case 'agent':
        return { ...s, entries: capTail([...s.entries, {
          id: `agent-${Date.now()}-${s.entries.length}`, kind: 'agent', summary: str(a, 'text'), status: 'ok', at: Date.now(),
        }], MAX_ENTRIES) };
      case 'log':
        return { ...s, entries: capTail([...s.entries, {
          id: `log-${Date.now()}-${s.entries.length}`, kind: 'log', summary: str(a, 'text'), status: 'ok', at: Date.now(),
        }], MAX_ENTRIES) };
      case 'filter': {
        const hidden = Array.isArray(a.hidden) ? a.hidden.map(String) : [];
        return { ...s, hidden };
      }
      case 'clear':
        return { ...s, entries: [] };
      default:
        return unknownCommand('terminal', cmd);
    }
  },
};

export default terminal;
