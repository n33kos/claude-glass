import { type AppDef, type Args, capTail, clip, str, unknownCommand } from '../types';

// The Action app: where the glass answers back. When Claude Code asks the user's permission, the
// glass mod puts a card here (and the same choices in the terminal, whichever is answered first
// wins). Two-way, so it says so in Settings; answers only ever come from the glass's own UI, never
// from the socket or the CLI (src/core/server.ts).
export type Choice = 'allow' | 'always' | 'deny';

/** One of Claude's questions (AskUserQuestion), as the card shows it. */
export interface Question {
  question: string;
  header?: string;
  multiSelect: boolean;
  options: { label: string; description?: string }[];
}

export interface ActionRequest {
  id: string;
  kind: 'permission' | 'question';
  tool: string;
  summary: string; // one line: what Claude wants to do (or its first question)
  detail?: string; // the command, the change, the URL... (clipped)
  canAlways: boolean; // Claude Code offered "don't ask again" rules for it
  questions?: Question[]; // kind question
  status: 'pending' | 'answered';
  answer?: { choice: Choice | 'terminal' | 'answered'; by: 'glass' | 'terminal' | 'timeout' | 'interrupted'; answers?: Record<string, string> };
  at: number;
  answeredAt?: number;
}

/** Claude's questions from the tool's input, checked and trimmed for a card. */
export function parseQuestions(raw: unknown): Question[] {
  const qs = Array.isArray(raw) ? raw : [];
  return qs.slice(0, 4).map((q: any) => ({
    question: clip(String(q?.question ?? ''), 500),
    ...(q?.header ? { header: String(q.header).slice(0, 24) } : {}),
    multiSelect: q?.multiSelect === true,
    options: (Array.isArray(q?.options) ? q.options : []).slice(0, 6).map((o: any) => ({
      label: String(o?.label ?? o ?? '').slice(0, 120), ...(o?.description ? { description: clip(String(o.description), 300) } : {}),
    })),
  })).filter((q) => q.question);
}

export interface ActionState { requests: ActionRequest[] }

const MAX = 40;
const CHOICES: Choice[] = ['allow', 'always', 'deny'];

export const action: AppDef<ActionState> = {
  type: 'action',
  title: 'Action',
  icon: '◉',
  singleton: true,
  description: "Approvals from the glass: when Claude Code asks permission or Claude asks a question, answer here or in the terminal. Two-way; fills itself.",
  commands: {
    clear: { usage: 'clear', help: 'Forget answered requests' },
  },
  viewCommands: ['answer', 'dismiss'],
  internal: ['request', 'answer', 'close', 'dismiss'],
  permissions: { network: [], microphone: false, storage: false, sharedSignIn: false, twoWay: true, reads: [] },
  settings: {
    approvals: { type: 'bool', label: 'Answer permission prompts from the glass (and the terminal, whichever is first)', default: true },
    keepAnswered: { type: 'bool', label: 'Keep answered requests listed', default: false },
    holdMinutes: { type: 'number', label: 'Minutes to wait before falling back to Claude Code\'s own prompt', default: 10, min: 1, max: 60 },
    questions: { type: 'bool', label: 'Answer Claude\'s questions in the glass while it\'s open (the terminal shows a short version)', default: true },
  },
  init: () => ({ requests: [] }),
  command(s, cmd, a: Args) {
    switch (cmd) {
      case 'request': {
        const id = str(a, 'id');
        if (s.requests.some((r) => r.id === id)) return s;
        const questions = a.kind === 'question' ? parseQuestions(a.questions) : undefined;
        if (questions && !questions.length) throw new Error('action: a question request needs questions');
        const req: ActionRequest = {
          id, kind: questions ? 'question' : 'permission', tool: str(a, 'tool'), summary: clip(questions ? questions[0].question : str(a, 'summary'), 300),
          ...(a.detail ? { detail: clip(String(a.detail), 4000) } : {}),
          ...(questions ? { questions } : {}),
          canAlways: a.canAlways === true, status: 'pending', at: Date.now(),
        };
        return { requests: capTail([...s.requests, req], MAX) };
      }
      case 'answer': // the glass's own UI only (the server refuses it from the socket)
      case 'close': { // answered elsewhere (the terminal), timed out, or interrupted
        const id = str(a, 'id');
        const r = s.requests.find((x) => x.id === id);
        if (!r || r.status !== 'pending') return s;
        const by = cmd === 'answer' ? 'glass' : (['terminal', 'timeout', 'interrupted'].includes(String(a.by)) ? a.by : 'terminal') as NonNullable<ActionRequest['answer']>['by'];
        let answer: NonNullable<ActionRequest['answer']>;
        if (r.kind === 'question' && cmd === 'answer') {
          // Every question answered: an option's label (labels comma-joined for multi-select) or the user's own words.
          const given = a.answers && typeof a.answers === 'object' ? a.answers as Record<string, unknown> : {};
          const answers = Object.fromEntries((r.questions ?? []).map((q) => [q.question, String(given[q.question] ?? '').trim().slice(0, 2000)]));
          if (Object.values(answers).some((v) => !v)) throw new Error('action: answer every question');
          answer = { choice: 'answered', by, answers };
        } else {
          const choice = String(a.choice ?? (cmd === 'close' ? 'terminal' : ''));
          if (cmd === 'answer' && !CHOICES.includes(choice as Choice)) throw new Error(`action: answer --choice ${CHOICES.join('|')}`);
          if (choice === 'always' && !r.canAlways) throw new Error('action: "always" isn\'t offered for this request');
          const answers = cmd === 'close' && a.answers && typeof a.answers === 'object' ? a.answers as Record<string, string> : undefined;
          answer = { choice: (answers ? 'answered' : choice) as NonNullable<ActionRequest['answer']>['choice'], by, ...(answers ? { answers } : {}) };
        }
        return { requests: s.requests.map((x) => (x.id === id ? { ...x, status: 'answered', answer, answeredAt: Date.now() } : x)) };
      }
      case 'dismiss':
        return { requests: s.requests.filter((x) => x.id !== str(a, 'id') || x.status === 'pending') };
      case 'clear':
        return { requests: s.requests.filter((x) => x.status === 'pending') };
      default:
        return unknownCommand('action', cmd);
    }
  },
};

export default action;
