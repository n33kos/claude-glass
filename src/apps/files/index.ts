import { type AppDef, type Args, unknownCommand } from '../types';

// Every file Claude reads or changes in the session, and how often, for a list or a folder tree.
export interface FileStat { reads: number; edits: number; first: number; last: number }
export interface FilesState {
  cwd?: string;
  files: Record<string, FileStat>; // path relative to the project when inside it
  view?: 'list' | 'tree';
}

const MAX_FILES = 400;
const READS = new Set(['Read']);
const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

const rel = (path: string, cwd?: string) => (cwd && path.startsWith(cwd.replace(/\/$/, '') + '/') ? path.slice(cwd.replace(/\/$/, '').length + 1) : path);

export const files: AppDef<FilesState> = {
  type: 'files',
  title: 'Files',
  icon: '▤',
  singleton: true,
  description: 'Every file Claude read or changed this session: most recent first, or as a folder tree; a changed file opens its diff in Changes. Fills itself.',
  commands: {
    view: { usage: 'view --mode list|tree', help: 'Most recent first, or a folder tree', view: true },
    clear: { usage: 'clear', help: 'Forget the session so far' },
  },
  init: () => ({ files: {} }),
  command(s, cmd, a: Args) {
    if (cmd === 'view') {
      if (a.mode !== 'list' && a.mode !== 'tree') throw new Error('files: view --mode list|tree');
      return { ...s, view: a.mode };
    }
    if (cmd === 'clear') return { ...files.init(), view: s.view };
    return unknownCommand('files', cmd);
  },
  onEvent(s, ev) {
    if (ev?.e === 'session.start' && ev.source === 'clear') return Object.keys(s.files).length ? { ...files.init(), view: s.view } : s;
    if (ev?.e !== 'tool.end' || ev.error) return s;
    const tool = ev.tool;
    const kind = READS.has(tool) ? 'reads' : EDITS.has(tool) ? 'edits' : null;
    const abs = ev.input?.file_path ?? ev.input?.notebook_path;
    if (!kind || typeof abs !== 'string') return s;
    const cwd = s.cwd ?? ev.cwd;
    const path = rel(abs, cwd);
    const now = Date.now();
    const prev = s.files[path] ?? { reads: 0, edits: 0, first: now, last: now };
    let fileMap = { ...s.files, [path]: { ...prev, [kind]: prev[kind] + 1, last: now } };
    if (Object.keys(fileMap).length > MAX_FILES) {
      const oldest = Object.entries(fileMap).sort((x, y) => x[1].last - y[1].last)[0][0];
      const { [oldest]: _, ...rest } = fileMap;
      fileMap = rest;
    }
    // A glass saved with the old map view drops what only the map used.
    const { links: _l, turn: _t, ...kept } = s as FilesState & { links?: unknown; turn?: unknown };
    return { ...kept, cwd, files: fileMap, view: s.view === 'list' || s.view === 'tree' ? s.view : undefined };
  },
};

export default files;
