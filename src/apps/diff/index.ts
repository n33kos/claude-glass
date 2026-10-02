import { diffLines, type Hunk } from '../../core/linediff';
import { type AppDef, type Args, capTail, str, unknownCommand } from '../types';

export interface Revision {
  at: number;
  source: string; // tool name or "claude"
  hunks: Hunk[];
  note?: string;
  turnId?: string; // the turn that made it
}

export interface DiffState {
  files: string[]; // most recently changed first
  revisions: Record<string, Revision[]>;
  selected: string | null;
  cursor: Record<string, number>; // per-file revision index being viewed; -1/absent = latest
  turn?: string; // the latest turn that changed something
  scope?: 'all' | 'turn'; // the file list: everything, or only what the latest turn changed
}

const MAX_FILES = 100;
const MAX_REVS = 50;

export const diff: AppDef<DiffState> = {
  type: 'diff',
  title: 'Changes',
  icon: '±',
  singleton: false,
  description: 'Visual diffs per file; flip left/right through each revision. File edits land in the "changes" instance automatically.',
  commands: {
    add: { usage: 'add --path <file> (--before <text> --after <text> | --before-file F --after-file F)', help: 'Add a diff revision for a file' },
    select: { usage: 'select --path <file>', help: 'Show a file', view: true },
    scope: { usage: 'scope --scope all|turn', help: 'List every changed file, or only the latest turn\'s', view: true },
    clear: { usage: 'clear', help: 'Remove all diffs' },
  },
  init: () => ({ files: [], revisions: {}, selected: null, cursor: {} }),
  // Public state (apps that read "diff"): which files changed, how often, and which in the latest turn.
  share: (s) => ({
    selected: s.selected,
    files: s.files.slice(0, 50).map((path) => {
      const revs = s.revisions[path] ?? [];
      return { path, changes: revs.length, lastAt: revs[revs.length - 1]?.at ?? 0, thisTurn: !!s.turn && revs.some((r) => r.turnId === s.turn) };
    }),
  }),
  command(s, cmd, a: Args) {
    switch (cmd) {
      case 'add': {
        const path = str(a, 'path');
        const hunks: Hunk[] = Array.isArray(a.hunks) ? (a.hunks as Hunk[])
          : diffLines(str(a, 'before', false), str(a, 'after', false));
        const turnId = a.turnId ? String(a.turnId) : undefined;
        const rev: Revision = { at: Date.now(), source: String(a.source ?? 'claude'), hunks, note: a.note ? String(a.note) : undefined, ...(turnId ? { turnId } : {}) };
        const revs = capTail([...(s.revisions[path] ?? []), rev], MAX_REVS);
        const files = [path, ...s.files.filter((f) => f !== path)].slice(0, MAX_FILES);
        const revisions: Record<string, Revision[]> = {};
        for (const f of files) revisions[f] = f === path ? revs : s.revisions[f];
        const cursor = { ...s.cursor };
        delete cursor[path]; // jump to latest on new revision
        return { ...s, files, revisions, selected: path, cursor, turn: turnId ?? s.turn };
      }
      case 'scope': {
        if (a.scope !== 'all' && a.scope !== 'turn') throw new Error('diff: scope --scope all|turn');
        return { ...s, scope: a.scope };
      }
      case 'select': {
        const path = str(a, 'path');
        if (!s.revisions[path]) throw new Error(`diff: no such file ${path}`);
        const cursor = a.index === undefined ? s.cursor : { ...s.cursor, [path]: Number(a.index) };
        return { ...s, selected: path, cursor };
      }
      case 'clear':
        return { ...diff.init(), scope: s.scope };
      default:
        return unknownCommand('diff', cmd);
    }
  },
};

export default diff;
