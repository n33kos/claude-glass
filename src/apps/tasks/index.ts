import { type AppDef, type Args, capTail, unknownCommand } from '../types';

// Claude's own to-do list, live: filled from its task tools (TaskCreate/TaskUpdate, or TodoWrite
// in versions that use it). Nothing for Claude to drive; it's the plan it's already keeping.
export type TaskStatus = 'pending' | 'in_progress' | 'completed';
export interface TaskItem { id: string; subject: string; description?: string; activeForm?: string; status: TaskStatus; at: number }
export interface TasksState { items: TaskItem[]; updatedAt: number }

const MAX = 100;
const status = (v: unknown): TaskStatus => (v === 'in_progress' || v === 'completed' ? v : 'pending');

export const tasks: AppDef<TasksState> = {
  type: 'tasks',
  title: 'Tasks',
  icon: '☑',
  singleton: true,
  autoOpen: true,
  description: "Claude's to-do list, live, from its task tools. Fills itself; nothing to drive.",
  commands: {
    clear: { usage: 'clear', help: 'Empty the list' },
  },
  init: () => ({ items: [], updatedAt: 0 }),
  // Public state (apps that read "tasks"): the list and where each task stands.
  share: (s) => ({ items: s.items.map((t) => ({ subject: t.subject, status: t.status, ...(t.activeForm ? { activeForm: t.activeForm } : {}) })) }),
  command(s, cmd, _a: Args) {
    if (cmd === 'clear') return tasks.init();
    return unknownCommand('tasks', cmd);
  },
  onEvent(s, ev) {
    if (ev?.e === 'session.start' && ev.source === 'clear') return s.items.length ? tasks.init() : s;
    if (ev?.e !== 'tool.end' || ev.error) return s;
    const input = ev.input ?? {}, res = ev.result ?? {};
    const now = Date.now();
    switch (ev.tool) {
      case 'TaskCreate': {
        const id = String(res.task?.id ?? res.id ?? s.items.length + 1);
        // A fresh list after the last one was all done: start over rather than pile up.
        const base = s.items.length && s.items.every((t) => t.status === 'completed') ? [] : s.items.filter((t) => t.id !== id);
        const item: TaskItem = { id, subject: String(input.subject ?? res.task?.subject ?? 'Task'), description: input.description ? String(input.description) : undefined,
          activeForm: input.activeForm ? String(input.activeForm) : undefined, status: 'pending', at: now };
        return { items: capTail([...base, item], MAX), updatedAt: now };
      }
      case 'TaskUpdate': {
        const id = String(input.taskId ?? res.taskId ?? '');
        if (input.status === 'deleted') return { items: s.items.filter((t) => t.id !== id), updatedAt: now };
        if (!s.items.some((t) => t.id === id)) return s;
        return {
          items: s.items.map((t) => t.id !== id ? t : {
            ...t, at: now,
            ...(input.status ? { status: status(input.status) } : {}),
            ...(input.subject ? { subject: String(input.subject) } : {}),
            ...(input.description ? { description: String(input.description) } : {}),
            ...(input.activeForm ? { activeForm: String(input.activeForm) } : {}),
          }),
          updatedAt: now,
        };
      }
      case 'TodoWrite': {
        const todos = Array.isArray(input.todos) ? input.todos : [];
        return {
          items: todos.slice(0, MAX).map((t: any, i: number) => ({ id: String(t.id ?? i + 1), subject: String(t.content ?? t.subject ?? ''), activeForm: t.activeForm ? String(t.activeForm) : undefined, status: status(t.status), at: now })),
          updatedAt: now,
        };
      }
      default: return s;
    }
  },
};

export default tasks;
