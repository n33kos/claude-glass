import { type AppDef, type Args, capTail, clip, unknownCommand } from '../types';

// The subagents Claude starts: what each was asked, whether it's still going, and what it reported.
// Built from the Agent tool call (PreToolUse → PostToolUse) and SubagentStart/SubagentStop, which
// carry the agent's id and its last message.
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
  onHook(s, p) {
    const ev = p?.hook_event_name;
    const isAgent = p?.tool_name === 'Agent' || p?.tool_name === 'Task';
    const now = Date.now();
    const update = (match: (r: AgentRun) => boolean, patch: (r: AgentRun) => Partial<AgentRun>) => {
      const i = s.runs.map(match).lastIndexOf(true);
      if (i === -1) return s;
      return { runs: s.runs.map((r, j) => (j === i ? { ...r, ...patch(r) } : r)) };
    };
    if (ev === 'PreToolUse' && isAgent) {
      const i = p.tool_input ?? {};
      const run: AgentRun = {
        key: String(p.tool_use_id ?? now), type: String(i.subagent_type ?? 'general-purpose'),
        description: String(i.description ?? 'Agent'), prompt: clip(String(i.prompt ?? ''), 4000), status: 'running', startedAt: now,
      };
      return { runs: capTail([...s.runs.filter((r) => r.key !== run.key), run], MAX) };
    }
    if (ev === 'PostToolUse' && isAgent) {
      const r = p.tool_response ?? {};
      const background = r.isAsync === true || r.status === 'async_launched';
      const result = text(r.content ?? r.result);
      return update((x) => x.key === String(p.tool_use_id), (x) => ({
        agentId: r.agentId ? String(r.agentId) : x.agentId,
        ...(background ? { background: true } : { status: x.status === 'running' ? 'done' : x.status, endedAt: x.endedAt ?? now, ...(result ? { result: clip(result, 8000) } : {}) }),
      }));
    }
    if (ev === 'PostToolUseFailure' && isAgent) {
      return update((x) => x.key === String(p.tool_use_id), () => ({ status: 'failed', endedAt: now, result: String(p.error ?? 'failed') }));
    }
    if (ev === 'SubagentStart' && p.agent_id) {
      const id = String(p.agent_id);
      // Tie the agent to its call: by id if the call already told us, else the newest running one of its type.
      if (s.runs.some((r) => r.agentId === id)) return s;
      return update((x) => x.status === 'running' && !x.agentId && (!p.agent_type || x.type === p.agent_type), () => ({ agentId: id }));
    }
    if (ev === 'SubagentStop' && p.agent_id) {
      const id = String(p.agent_id);
      return update((x) => x.agentId === id, (x) => ({ status: 'done', endedAt: now, result: clip(String(p.last_assistant_message ?? x.result ?? ''), 8000) }));
    }
    return s;
  },
};

export default agents;
