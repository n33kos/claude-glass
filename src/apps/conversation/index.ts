import { type AppDef, type Args, capTail, str, unknownCommand } from '../types';

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  parts: string[]; // assistant chunks by MessageDisplay index; user = [text]
  done: boolean;
  at: number;
}

export interface ConversationState {
  messages: Message[];
}

const MAX_MESSAGES = 500;

export const messageText = (m: Message) => m.parts.join('');

export const conversation: AppDef<ConversationState> = {
  type: 'conversation',
  title: 'Conversation',
  icon: '💬',
  singleton: true,
  description: 'The conversation between the user and Claude, without tool calls. Streams automatically.',
  commands: {
    clear: { usage: 'clear', help: 'Clear the conversation view' },
  },
  init: () => ({ messages: [] }),
  command(s, cmd, a: Args) {
    switch (cmd) {
      case 'user':
        return { messages: capTail([...s.messages, {
          id: String(a.id ?? `user-${Date.now()}`), role: 'user', parts: [str(a, 'text')], done: true, at: Date.now(),
        }], MAX_MESSAGES) };
      case 'chunk': {
        const id = str(a, 'messageId');
        const index = Number(a.index ?? 0);
        const delta = str(a, 'delta', false);
        const final = Boolean(a.final);
        const i = s.messages.findIndex((m) => m.id === id && m.role === 'assistant');
        const base: Message = i === -1
          ? { id, role: 'assistant', parts: [], done: false, at: Date.now() }
          : s.messages[i];
        const parts = base.parts.slice();
        while (parts.length < index) parts.push('');
        parts[index] = delta;
        const msg = { ...base, parts, done: base.done || final };
        const messages = i === -1 ? capTail([...s.messages, msg], MAX_MESSAGES) : s.messages.map((m, j) => (j === i ? msg : m));
        return { messages };
      }
      case 'turnEnd':
        return { messages: s.messages.map((m) => (m.done ? m : { ...m, done: true })) };
      case 'clear':
        return { messages: [] };
      default:
        return unknownCommand('conversation', cmd);
    }
  },
};
