// Deterministic hook → state mapping. Zero Claude tokens: everything here happens automatically.
import { searchResults } from '../apps/browser';
import { summarizeTool } from '../apps/terminal';
import { autoCommand, reduce } from './reducer';
import type { GlassState, Waiting } from './types';

export interface HookContext {
  /** Copy a file into the session files dir; returns the stored absolute path (or null). */
  ingestFile(path: string): string | null;
  /** Read a text file (for plan files after an Edit). Returns null if unreadable. */
  readText(path: string): string | null;
  /** App types the user turned off: hooks leave them untouched. */
  disabled?: ReadonlySet<string>;
  /** Experiment: 'history' gives every action its own new window instead of reusing one. */
  windowMode?: 'live' | 'history';
  /** Set per hook: the tool call this hook belongs to (history mode keys windows by it). */
  toolUseId?: string;
}

const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;
const PLAN_RE = /(^|\/)(plans?\/[^/]+\.md|PLAN\.md)$/i;
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write']);

const cmd = (s: GlassState, id: string, command: string, args: Record<string, unknown>) =>
  reduce(s, { type: 'app.command', id, command, args }).state;

const setWaiting = (s: GlassState, waiting: Waiting | undefined) =>
  s.session.waiting === waiting ? s : reduce(s, { type: 'session.update', patch: { waiting } }).state;

function questionWait(p: any): Waiting {
  const qs = Array.isArray(p.tool_input?.questions) ? p.tool_input.questions : [];
  const questions = qs.map((q: any) => ({
    question: String(q?.question ?? ''),
    header: q?.header ? String(q.header) : undefined,
    options: (Array.isArray(q?.options) ? q.options : []).map((o: any) => ({
      label: String(o?.label ?? o ?? ''), description: o?.description ? String(o.description) : undefined,
    })),
  }));
  return {
    kind: 'question', summary: questions[0]?.question || 'Claude has a question',
    tool: p.tool_name, toolUseId: p.tool_use_id, questions, since: Date.now(),
  };
}

/** A PostToolUse ends the wait it belongs to (or any wait we couldn't tie to a tool call). */
const endsWait = (w: Waiting | undefined, p: any) => !!w && (!w.toolUseId || !p.tool_use_id || w.toolUseId === p.tool_use_id);

export function applyHook(s: GlassState, p: any, ctx: HookContext): GlassState {
  // Built-in effects first, then any app that watches hooks itself (onHook).
  const next = reduce(builtinHook(s, p, { ...ctx, toolUseId: p?.tool_use_id ? String(p.tool_use_id) : undefined }), { type: 'app.hook', payload: p }).state;
  return ctx.disabled?.size ? withoutDisabled(s, next, ctx.disabled) : next;
}

/** Undo whatever a hook did to apps the user turned off (built-in or custom alike). */
export function withoutDisabled(prev: GlassState, next: GlassState, disabled: ReadonlySet<string>): GlassState {
  const ids = Object.values(next.instances).filter((i) => disabled.has(i.type)).map((i) => i.id);
  if (!ids.some((id) => next.appState[id] !== prev.appState[id] || !prev.instances[id])) return next;
  const out: GlassState = { ...next, instances: { ...next.instances }, appState: { ...next.appState } };
  for (const id of ids) {
    if (prev.instances[id]) { out.appState[id] = prev.appState[id]; continue; }
    delete out.instances[id];
    delete out.appState[id];
    out.order = out.order.filter((o) => o !== id);
    out.autoOpened = out.autoOpened.filter((o) => o !== id);
  }
  return out;
}

function builtinHook(s: GlassState, p: any, ctx: HookContext): GlassState {
  const event: string = p?.hook_event_name ?? '';
  const auto = s.settings.autoOpen;
  switch (event) {
    case 'PermissionRequest':
      return setWaiting(s, {
        kind: 'permission', summary: summarizeTool(p.tool_name ?? '?', p.tool_input),
        tool: p.tool_name, toolUseId: p.tool_use_id, since: Date.now(),
      });
    case 'Notification': {
      // Only permission prompts; idle reminders are already covered by the "Idle" presence.
      const isPermission = p.notification_type === 'permission_prompt' || (!p.notification_type && /permission/i.test(p.message ?? ''));
      if (!isPermission || s.session.waiting) return s;
      return setWaiting(s, { kind: 'permission', summary: String(p.message ?? 'Claude needs your permission'), since: Date.now() });
    }
    case 'UserPromptSubmit': {
      s = setWaiting(s, undefined);
      // endedAt: in folder scope another session may have ended while this one keeps going.
      s = reduce(s, { type: 'session.update', patch: { activity: 'working', endedAt: undefined } }).state;
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
      if (p.tool_name === 'AskUserQuestion') s = setWaiting(s, questionWait(p));
      // Web research shows up in the browser as it starts: the query, or the page being fetched.
      if (p.tool_name === 'WebSearch' && p.tool_input?.query) s = web(s, ctx, 'web.search', { query: String(p.tool_input.query) });
      if (p.tool_name === 'WebFetch' && p.tool_input?.url) s = web(s, ctx, 'web.page', { url: String(p.tool_input.url) });
      return cmd(s, 'terminal', 'tool.start', { id: p.tool_use_id ?? `t-${Date.now()}`, tool: p.tool_name, input: p.tool_input });
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      const tool: string = p.tool_name ?? '?';
      const input = p.tool_input ?? {};
      const response = p.tool_response;
      if (endsWait(s.session.waiting, p)) s = setWaiting(s, undefined);
      s = cmd(s, 'terminal', 'tool.end', {
        id: p.tool_use_id ?? `t-${Date.now()}`, tool, input, response,
        durationMs: p.duration_ms, error: event === 'PostToolUseFailure' || response?.is_error || undefined,
      });
      return applyToolSideEffects(s, tool, input, response, ctx, auto);
    }
    case 'Stop':
      s = reduce(s, { type: 'session.update', patch: { activity: 'idle', waiting: undefined } }).state;
      return cmd(s, 'conversation', 'turnEnd', {});
    case 'SubagentStart':
      return cmd(s, 'terminal', 'agent', { text: `▸ subagent started${p.agent_type ? ` (${p.agent_type})` : ''}` });
    case 'SubagentStop':
      return cmd(s, 'terminal', 'agent', { text: `◂ subagent finished${p.agent_type ? ` (${p.agent_type})` : ''}` });
    case 'SessionEnd':
      return reduce(s, { type: 'session.update', patch: { endedAt: Date.now(), activity: 'idle', waiting: undefined } }).state;
    case 'SessionStart':
      s = reduce(s, { type: 'session.update', patch: { endedAt: undefined, cwd: p.cwd ?? s.session.cwd } }).state;
      // A session joining a glass with history (folder scope, /clear, resume) gets a divider.
      if (p.source && p.source !== 'compact' && (s.appState.terminal as { entries?: unknown[] } | undefined)?.entries?.length) s = cmd(s, 'terminal', 'agent', { text: `── session ${p.source}${p.session_id ? ` · ${String(p.session_id).slice(0, 8)}` : ''} ──` });
      return s;
    default:
      return s;
  }
}

/**
 * The one seam for window modes. live: updates go to the fixed window (`changes`, `plan`,
 * `images`, `browser`). history: every action gets its own window, keyed by its tool call (so a
 * search's start and its results share one). New windows open at
 * slot 0 and push older ones toward later desktops: a running visual log.
 */
function autoWindow(s: GlassState, ctx: HookContext, opts: Parameters<typeof autoCommand>[1]): GlassState {
  if (ctx.windowMode !== 'history') return autoCommand(s, opts);
  const key = (ctx.toolUseId ?? String(Date.now())).replace(/[^A-Za-z0-9]/g, '').slice(-10);
  return pruneHistory(autoCommand(s, { ...opts, id: `${opts.id}-${key}` }));
}

export const HISTORY_LIMIT = 12;
const HISTORY_ID = /^(changes|plan|images|browser)-[A-Za-z0-9]+$/;

/** History mode keeps only the newest `historyLimit` history windows; older ones are deleted (pinned ones stay). */
function pruneHistory(s: GlassState): GlassState {
  const limit = Math.max(1, Math.floor(Number(s.settings.historyLimit ?? HISTORY_LIMIT)));
  const pinned = new Set(Object.values(s.tucked ?? {}).flat());
  const old = Object.values(s.instances)
    .filter((i) => HISTORY_ID.test(i.id) && !pinned.has(i.id))
    .sort((a, b) => b.createdAt - a.createdAt || rank(s, a.id) - rank(s, b.id))
    .slice(limit);
  for (const i of old) s = reduce(s, { type: 'instance.delete', id: i.id }).state;
  return s;
}
const rank = (s: GlassState, id: string) => { const i = s.order.indexOf(id); return i < 0 ? Infinity : i; };

const web = (s: GlassState, ctx: HookContext, command: string, args: Record<string, unknown>) =>
  autoWindow(s, ctx, { id: 'browser', appType: 'browser', title: 'Browser', command, args, autoOpen: s.settings.autoOpen.web !== false });

function applyToolSideEffects(
  s: GlassState, tool: string, input: any, response: any, ctx: HookContext, auto: GlassState['settings']['autoOpen'],
): GlassState {
  const path: string | undefined = input.file_path;

  if (EDIT_TOOLS.has(tool) && path) {
    const patch = response?.structuredPatch;
    const args: Record<string, unknown> = { path, source: tool };
    if (Array.isArray(patch) && patch.length) args.hunks = patch;
    else if (tool === 'Write') { args.before = ''; args.after = String(input.content ?? ''); }
    else { args.before = String(input.old_string ?? ''); args.after = String(input.new_string ?? ''); }
    s = autoWindow(s, ctx, { id: 'changes', appType: 'diff', title: 'Changes', command: 'add', args, autoOpen: auto.changes });

    if (PLAN_RE.test(path)) {
      const text = tool === 'Write' ? String(input.content ?? '') : ctx.readText(path);
      if (text != null) s = autoWindow(s, ctx, { id: 'plan', appType: 'markdown', title: 'Plan', command: 'set', args: { text, source: path }, autoOpen: auto.plan });
    }
  }

  if (tool === 'ExitPlanMode' && typeof input.plan === 'string') {
    s = autoWindow(s, ctx, { id: 'plan', appType: 'markdown', title: 'Plan', command: 'set', args: { text: input.plan }, autoOpen: auto.plan });
  }

  if (tool === 'WebSearch' && input.query && response) {
    s = web(s, ctx, 'web.search', { query: String(input.query), results: searchResults(response) });
  }

  if (tool === 'Read' && path && IMAGE_RE.test(path)) {
    const stored = ctx.ingestFile(path);
    if (stored) s = autoWindow(s, ctx, { id: 'images', appType: 'image', title: 'Images', command: 'add', args: { file: stored, name: path.split('/').pop() }, autoOpen: auto.images });
  }
  return s;
}
