// Deterministic hook → state mapping. Zero Claude tokens: everything here happens automatically.
import { autoCommand, reduce } from './reducer';
import type { CanvasState } from './types';

export interface HookContext {
  /** Copy a file into the session files dir; returns the stored absolute path (or null). */
  ingestFile(path: string): string | null;
  /** Read a text file (for plan files after an Edit). Returns null if unreadable. */
  readText(path: string): string | null;
}

const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;
const PLAN_RE = /(^|\/)(plans?\/[^/]+\.md|PLAN\.md)$/i;
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write']);

const cmd = (s: CanvasState, id: string, command: string, args: Record<string, unknown>) =>
  reduce(s, { type: 'app.command', id, command, args }).state;

export function applyHook(s: CanvasState, p: any, ctx: HookContext): CanvasState {
  const event: string = p?.hook_event_name ?? '';
  const auto = s.settings.autoOpen;
  switch (event) {
    case 'UserPromptSubmit': {
      s = reduce(s, { type: 'session.update', patch: { activity: 'working' } }).state;
      return cmd(s, 'conversation', 'user', { text: String(p.prompt ?? ''), id: p.prompt_id });
    }
    case 'MessageDisplay': {
      // Older payload shape fallback: {message_text, is_continued}.
      const messageId = p.message_id ?? p.turn_id ?? `msg-${Date.now()}`;
      const delta = p.delta ?? p.message_text ?? '';
      return cmd(s, 'conversation', 'chunk', { messageId, index: p.index ?? 0, delta, final: p.final ?? true });
    }
    case 'PreToolUse':
      s = reduce(s, { type: 'session.update', patch: { activity: 'working' } }).state;
      return cmd(s, 'terminal', 'tool.start', { id: p.tool_use_id ?? `t-${Date.now()}`, tool: p.tool_name, input: p.tool_input });
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      const tool: string = p.tool_name ?? '?';
      const input = p.tool_input ?? {};
      const response = p.tool_response;
      s = cmd(s, 'terminal', 'tool.end', {
        id: p.tool_use_id ?? `t-${Date.now()}`, tool, input, response,
        durationMs: p.duration_ms, error: event === 'PostToolUseFailure' || response?.is_error || undefined,
      });
      return applyToolSideEffects(s, tool, input, response, ctx, auto);
    }
    case 'Stop':
      s = reduce(s, { type: 'session.update', patch: { activity: 'idle' } }).state;
      return cmd(s, 'conversation', 'turnEnd', {});
    case 'SubagentStart':
      return cmd(s, 'terminal', 'agent', { text: `▸ subagent started${p.agent_type ? ` (${p.agent_type})` : ''}` });
    case 'SubagentStop':
      return cmd(s, 'terminal', 'agent', { text: `◂ subagent finished${p.agent_type ? ` (${p.agent_type})` : ''}` });
    case 'SessionEnd':
      return reduce(s, { type: 'session.update', patch: { endedAt: Date.now(), activity: 'idle' } }).state;
    case 'SessionStart':
      return reduce(s, { type: 'session.update', patch: { endedAt: undefined, cwd: p.cwd ?? s.session.cwd } }).state;
    default:
      return s;
  }
}

function applyToolSideEffects(
  s: CanvasState, tool: string, input: any, response: any, ctx: HookContext, auto: CanvasState['settings']['autoOpen'],
): CanvasState {
  const path: string | undefined = input.file_path;

  if (EDIT_TOOLS.has(tool) && path) {
    const patch = response?.structuredPatch;
    const args: Record<string, unknown> = { path, source: tool };
    if (Array.isArray(patch) && patch.length) args.hunks = patch;
    else if (tool === 'Write') { args.before = ''; args.after = String(input.content ?? ''); }
    else { args.before = String(input.old_string ?? ''); args.after = String(input.new_string ?? ''); }
    s = autoCommand(s, { id: 'changes', appType: 'diff', title: 'Changes', command: 'add', args, autoOpen: auto.changes });

    if (PLAN_RE.test(path)) {
      const text = tool === 'Write' ? String(input.content ?? '') : ctx.readText(path);
      if (text != null) s = autoCommand(s, { id: 'plan', appType: 'markdown', title: 'Plan', command: 'set', args: { text, source: path }, autoOpen: auto.plan });
    }
  }

  if (tool === 'ExitPlanMode' && typeof input.plan === 'string') {
    s = autoCommand(s, { id: 'plan', appType: 'markdown', title: 'Plan', command: 'set', args: { text: input.plan }, autoOpen: auto.plan });
  }

  if (tool === 'Read' && path && IMAGE_RE.test(path)) {
    const stored = ctx.ingestFile(path);
    if (stored) s = autoCommand(s, { id: 'images', appType: 'image', title: 'Images', command: 'add', args: { file: stored, name: path.split('/').pop() }, autoOpen: auto.images });
  }
  return s;
}
