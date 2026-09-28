import { type AppDef, type Args, unknownCommand } from '../types';

// Every file Claude reads or changes in the session: how often, and which files it worked on
// together (touched within the same prompt), for a list by folder or a map.
export interface FileStat { reads: number; edits: number; first: number; last: number }
export interface FilesState {
  cwd?: string;
  files: Record<string, FileStat>; // path relative to the project when inside it
  links: Record<string, number>; // "a\u0000b" (sorted) → times touched in the same prompt
  view?: 'list' | 'tree' | 'map';
  turn?: { id: string; paths: string[] }; // the prompt being worked on, for links
}

const MAX_FILES = 400, MAX_LINKS = 1500, TURN_FAN = 12;
const READS = new Set(['Read']);
const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

const rel = (path: string, cwd?: string) => (cwd && path.startsWith(cwd.replace(/\/$/, '') + '/') ? path.slice(cwd.replace(/\/$/, '').length + 1) : path);

export const files: AppDef<FilesState> = {
  type: 'files',
  title: 'Files',
  icon: '▤',
  singleton: true,
  description: 'Every file Claude read or changed this session: most recent first, as a folder tree, or a map of what it worked on together. Fills itself.',
  commands: {
    view: { usage: 'view --mode list|tree|map', help: 'Most recent first, a folder tree, or a map', view: true },
    clear: { usage: 'clear', help: 'Forget the session so far' },
  },
  init: () => ({ files: {}, links: {} }),
  command(s, cmd, a: Args) {
    if (cmd === 'view') {
      if (a.mode !== 'list' && a.mode !== 'tree' && a.mode !== 'map') throw new Error('files: view --mode list|tree|map');
      return { ...s, view: a.mode };
    }
    if (cmd === 'clear') return { ...files.init(), view: s.view };
    return unknownCommand('files', cmd);
  },
  onHook(s, p) {
    if (p?.hook_event_name === 'SessionStart' && p.source === 'clear') return Object.keys(s.files).length ? { ...files.init(), view: s.view } : s;
    if (p?.hook_event_name !== 'PostToolUse') return s;
    const tool = p.tool_name;
    const kind = READS.has(tool) ? 'reads' : EDITS.has(tool) ? 'edits' : null;
    const abs = p.tool_input?.file_path ?? p.tool_input?.notebook_path;
    if (!kind || typeof abs !== 'string') return s;
    const cwd = s.cwd ?? p.cwd;
    const path = rel(abs, cwd);
    const now = Date.now();
    const prev = s.files[path] ?? { reads: 0, edits: 0, first: now, last: now };
    let fileMap = { ...s.files, [path]: { ...prev, [kind]: prev[kind] + 1, last: now } };
    if (Object.keys(fileMap).length > MAX_FILES) {
      const oldest = Object.entries(fileMap).sort((x, y) => x[1].last - y[1].last)[0][0];
      const { [oldest]: _, ...rest } = fileMap;
      fileMap = rest;
    }
    // Links: this file and the ones already touched for the same prompt.
    const turnId = String(p.prompt_id ?? '');
    const turn = s.turn?.id === turnId ? s.turn : { id: turnId, paths: [] };
    let links = s.links;
    if (turnId && !turn.paths.includes(path)) {
      links = { ...links };
      for (const other of turn.paths.slice(-TURN_FAN)) {
        const key = [other, path].sort().join('\u0000');
        links[key] = (links[key] ?? 0) + 1;
      }
      const keys = Object.keys(links);
      if (keys.length > MAX_LINKS) for (const k of keys.sort((x, y) => links[x] - links[y]).slice(0, keys.length - MAX_LINKS)) delete links[k];
    }
    return { ...s, cwd, files: fileMap, links, turn: { id: turnId, paths: turn.paths.includes(path) ? turn.paths : [...turn.paths, path].slice(-50) } };
  },
};

export default files;
