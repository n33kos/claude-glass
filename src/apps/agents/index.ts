import { type AppDef, type Args, capTail, clip, unknownCommand } from '../types';

// The subagents Claude starts: what each was asked, whether it's still going, and what it reported.
// Built from the Agent tool call (tool.start → tool.end, whose result names a background agent)
// and agent.end, a subagent's final answer.
export interface AgentRun {
  key: string; // the Agent tool call's id
  agentId?: string;
  type: string;
  description: string;
  prompt: string;
  status: 'running' | 'done' | 'failed';
  background?: boolean;
  startedAt: number;
  endedAt?: number;
  result?: string;
}
export interface AgentsState { runs: AgentRun[] }

const MAX = 60;
const text = (v: unknown): string => {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((c: any) => (typeof c === 'string' ? c : c?.text ?? '')).join('\n');
  return '';
};

export const agents: AppDef<AgentsState> = {
  type: 'agents',
  title: 'Agents',
  icon: '⧉',
  singleton: true,
  autoOpen: true,
  description: 'The subagents Claude runs: task, status, and what each reported. Fills itself.',
  commands: {
    clear: { usage: 'clear', help: 'Empty the list' },
  },
  init: () => ({ runs: [] }),
  command(s, cmd, _a: Args) {
    if (cmd === 'clear') return agents.init();
    return unknownCommand('agents', cmd);
  },
  onEvent(s, ev) {
    const isAgent = ev?.tool === 'Agent' || ev?.tool === 'Task';
    const now = Date.now();
    const update = (match: (r: AgentRun) => boolean, patch: (r: AgentRun) => Partial<AgentRun>) => {
      const i = s.runs.map(match).lastIndexOf(true);
      if (i === -1) return s;
      return { runs: s.runs.map((r, j) => (j === i ? { ...r, ...patch(r) } : r)) };
    };
    // Only the main loop's Agent calls: a subagent's own calls (agentId set) are its business.
    if (ev?.e === 'tool.start' && isAgent && !ev.agentId) {
      const i = ev.input ?? {};
      const run: AgentRun = {
        key: String(ev.id ?? now), type: String(i.subagent_type ?? 'general-purpose'),
        description: String(i.description ?? 'Agent'), prompt: clip(String(i.prompt ?? ''), 4000), status: 'running', startedAt: now,
      };
      return { runs: capTail([...s.runs.filter((r) => r.key !== run.key), run], MAX) };
    }
    if (ev?.e === 'tool.end' && isAgent && !ev.agentId) {
      if (ev.error) return update((x) => x.key === String(ev.id), () => ({ status: 'failed', endedAt: now, result: String(ev.error) }));
      const r = ev.result ?? {};
      const background = r.isAsync === true || r.status === 'async_launched';
      const result = text(r.content ?? r.result);
      return update((x) => x.key === String(ev.id), (x) => ({
        agentId: r.agentId ? String(r.agentId) : x.agentId,
        ...(background ? { background: true } : { status: x.status === 'running' ? 'done' : x.status, endedAt: x.endedAt ?? now, ...(result ? { result: clip(result, 8000) } : {}) }),
      }));
    }
    // A background agent finishes later: its own turn ends with its answer.
    if (ev?.e === 'agent.end' && ev.agentId) {
      const id = String(ev.agentId);
      return update((x) => x.agentId === id && x.status === 'running', (x) => ({
        status: ev.aborted ? 'failed' : 'done', endedAt: now, result: clip(String(ev.answer || x.result || ''), 8000),
      }));
    }
    return s;
  },
};

export default agents;
