import { type AppDef, type Args, capTail, clip, str, unknownCommand } from '../types';

// The Action app: where the glass answers back. When Claude Code asks the user's permission, the
// glass mod puts a card here (and the same choices in the terminal, whichever is answered first
// wins). Two-way, so it says so in Settings; answers only ever come from the glass's own UI, never
// from the socket or the CLI (src/core/server.ts).
export type Choice = 'allow' | 'always' | 'deny';

export interface ActionRequest {
  id: string;
  kind: 'permission';
  tool: string;
  summary: string; // one line: what Claude wants to do
  detail?: string; // the command, the change, the URL... (clipped)
  canAlways: boolean; // Claude Code offered "don't ask again" rules for it
  status: 'pending' | 'answered';
  answer?: { choice: Choice | 'terminal'; by: 'glass' | 'terminal' | 'timeout' | 'interrupted' };
  at: number;
  answeredAt?: number;
}

export interface ActionState { requests: ActionRequest[] }

const MAX = 40;
const CHOICES: Choice[] = ['allow', 'always', 'deny'];

export const action: AppDef<ActionState> = {
  type: 'action',
  title: 'Action',
  icon: '◉',
  singleton: true,
  description: "Approvals from the glass: when Claude Code asks permission, answer here or in the terminal. Two-way; fills itself.",
  commands: {
    clear: { usage: 'clear', help: 'Forget answered requests' },
  },
  viewCommands: ['answer', 'dismiss'],
  internal: ['request', 'answer', 'close', 'dismiss'],
  permissions: { network: [], microphone: false, storage: false, sharedSignIn: false, twoWay: true },
  settings: {
    approvals: { type: 'bool', label: 'Answer permission prompts from the glass (and the terminal, whichever is first)', default: true },
    keepAnswered: { type: 'bool', label: 'Keep answered requests listed', default: false },
    holdMinutes: { type: 'number', label: 'Minutes to wait before falling back to Claude Code\'s own prompt', default: 10, min: 1, max: 60 },
  },
  init: () => ({ requests: [] }),
  command(s, cmd, a: Args) {
    switch (cmd) {
      case 'request': {
        const id = str(a, 'id');
        if (s.requests.some((r) => r.id === id)) return s;
        const req: ActionRequest = {
          id, kind: 'permission', tool: str(a, 'tool'), summary: clip(str(a, 'summary'), 300),
          ...(a.detail ? { detail: clip(String(a.detail), 4000) } : {}),
          canAlways: a.canAlways === true, status: 'pending', at: Date.now(),
        };
        return { requests: capTail([...s.requests, req], MAX) };
      }
      case 'answer': // the glass's own UI only (the server refuses it from the socket)
      case 'close': { // answered elsewhere (the terminal), timed out, or interrupted
        const id = str(a, 'id');
        const r = s.requests.find((x) => x.id === id);
        if (!r || r.status !== 'pending') return s;
        const choice = String(a.choice ?? (cmd === 'close' ? 'terminal' : ''));
        if (cmd === 'answer' && !CHOICES.includes(choice as Choice)) throw new Error(`action: answer --choice ${CHOICES.join('|')}`);
        if (choice === 'always' && !r.canAlways) throw new Error('action: "always" isn\'t offered for this request');
        const by = cmd === 'answer' ? 'glass' : (['terminal', 'timeout', 'interrupted'].includes(String(a.by)) ? a.by : 'terminal') as NonNullable<ActionRequest['answer']>['by'];
        return { requests: s.requests.map((x) => (x.id === id ? { ...x, status: 'answered', answer: { choice: choice as Choice, by }, answeredAt: Date.now() } : x)) };
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
