import { diffLines, type Hunk } from '../../core/linediff';
import { type AppDef, type Args, capTail, str, unknownCommand } from '../types';

export interface Revision {
  at: number;
  source: string; // tool name or "claude"
  hunks: Hunk[];
  note?: string;
}

export interface DiffState {
  files: string[]; // most recently changed first
  revisions: Record<string, Revision[]>;
  selected: string | null;
  cursor: Record<string, number>; // per-file revision index being viewed; -1/absent = latest
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
    select: { usage: 'select --path <file>', help: 'Show a file' },
    clear: { usage: 'clear', help: 'Remove all diffs' },
  },
  init: () => ({ files: [], revisions: {}, selected: null, cursor: {} }),
  command(s, cmd, a: Args) {
    switch (cmd) {
      case 'add': {
        const path = str(a, 'path');
        const hunks: Hunk[] = Array.isArray(a.hunks) ? (a.hunks as Hunk[])
          : diffLines(str(a, 'before', false), str(a, 'after', false));
        const rev: Revision = { at: Date.now(), source: String(a.source ?? 'claude'), hunks, note: a.note ? String(a.note) : undefined };
        const revs = capTail([...(s.revisions[path] ?? []), rev], MAX_REVS);
        const files = [path, ...s.files.filter((f) => f !== path)].slice(0, MAX_FILES);
        const revisions: Record<string, Revision[]> = {};
        for (const f of files) revisions[f] = f === path ? revs : s.revisions[f];
        const cursor = { ...s.cursor };
        delete cursor[path]; // jump to latest on new revision
        return { files, revisions, selected: path, cursor };
      }
      case 'select': {
        const path = str(a, 'path');
        if (!s.revisions[path]) throw new Error(`diff: no such file ${path}`);
        const cursor = a.index === undefined ? s.cursor : { ...s.cursor, [path]: Number(a.index) };
        return { ...s, selected: path, cursor };
      }
      case 'clear':
        return diff.init();
      default:
        return unknownCommand('diff', cmd);
    }
  },
};
