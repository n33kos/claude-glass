// Deterministic event → state mapping. Zero Claude tokens: everything here happens automatically.
// Events come from the glass mod (hooks/glass-mod.ts), which watches the Claude Code session and
// hands each event to the glass through `claude-glass event`.
import { searchResults } from '../apps/browser';
import { summarizeTool } from '../apps/terminal';
import { autoCommand, reduce } from './reducer';
import type { GlassState, Waiting } from './types';

/**
 * What the mod sends: one JSON object per event (`e` names it). Tool inputs and results are the
 * tool's own (`input` = its arguments, `result` = its record, as Claude Code keeps them).
 */
export type GlassEvent =
  | { e: 'session.start'; source: 'startup' | 'clear' | 'resume' | 'compact' | 'fork' | string; sessionId?: string; cwd?: string }
  | { e: 'session.end'; reason?: string }
  | { e: 'turn.start'; turnId: string; text: string }
  /** The reply's text so far, in one block (`id` = turn, step and block): the whole text, not a delta. */
  | { e: 'text'; id: string; turnId?: string; text: string; final?: boolean }
  | { e: 'turn.complete'; turnId: string; durationMs?: number; reason?: string; aborted?: boolean }
  | { e: 'tool.start'; id: string; tool: string; input: any; agentId?: string; cwd?: string }
  | { e: 'tool.end'; id: string; tool: string; input: any; result?: any; error?: string; durationMs?: number; agentId?: string; cwd?: string }
  /** Claude Code is showing the user a permission prompt. */
  | { e: 'permission'; id?: string; tool: string; input: any }
  /** A subagent's run ended: its final answer. */
  | { e: 'agent.end'; agentId: string; answer?: string; aborted?: boolean };

export type GlassEventName = GlassEvent['e'];

export interface EventContext {
  /** Copy a file into the session files dir; returns the stored absolute path (or null). */
  ingestFile(path: string): string | null;
  /** Read a text file (for plan files after an Edit). Returns null if unreadable. */
  readText(path: string): string | null;
  /** App types the user turned off: events leave them untouched. */
  disabled?: ReadonlySet<string>;
  /** Experiment: 'history' gives every action its own new window instead of reusing one. */
  windowMode?: 'live' | 'history';
  /** Set per event: the tool call it belongs to (history mode keys windows by it). */
  toolUseId?: string;
}

const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;
const PLAN_RE = /(^|\/)(plans?\/[^/]+\.md|PLAN\.md)$/i;
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write']);

const cmd = (s: GlassState, id: string, command: string, args: Record<string, unknown>) =>
  reduce(s, { type: 'app.command', id, command, args }).state;

const setWaiting = (s: GlassState, waiting: Waiting | undefined) =>
  s.session.waiting === waiting ? s : reduce(s, { type: 'session.update', patch: { waiting } }).state;

function questionWait(id: string, input: any): Waiting {
  const qs = Array.isArray(input?.questions) ? input.questions : [];
  const questions = qs.map((q: any) => ({
    question: String(q?.question ?? ''),
    header: q?.header ? String(q.header) : undefined,
    options: (Array.isArray(q?.options) ? q.options : []).map((o: any) => ({
      label: String(o?.label ?? o ?? ''), description: o?.description ? String(o.description) : undefined,
    })),
  }));
  return {
    kind: 'question', summary: questions[0]?.question || 'Claude has a question',
    tool: 'AskUserQuestion', toolUseId: id, questions, since: Date.now(),
  };
}

/** A finished tool call ends the wait it belongs to (or a wait we couldn't tie to a call). */
const endsWait = (w: Waiting | undefined, id: string) => !!w && (!w.toolUseId || w.toolUseId === id);

export function applyEvent(s: GlassState, ev: GlassEvent, ctx: EventContext): GlassState {
  if (!ev || typeof ev !== 'object' || typeof (ev as { e?: unknown }).e !== 'string') return s;
  // Anything from the mod means it's running after all.
  if (s.session.modMissing) s = reduce(s, { type: 'session.update', patch: { modMissing: undefined } }).state;
  // Built-in effects first, then any app that watches events itself (onEvent).
  const toolUseId = 'id' in ev && (ev.e === 'tool.start' || ev.e === 'tool.end') ? String(ev.id) : undefined;
  const next = reduce(builtinEvent(s, ev, { ...ctx, toolUseId }), { type: 'app.event', event: ev }).state;
  return ctx.disabled?.size ? withoutDisabled(s, next, ctx.disabled) : next;
}

/** Undo whatever an event did to apps the user turned off (built-in or custom alike). */
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

function builtinEvent(s: GlassState, ev: GlassEvent, ctx: EventContext): GlassState {
  const auto = s.settings.autoOpen;
  switch (ev.e) {
    case 'permission':
      return setWaiting(s, {
        kind: 'permission', summary: summarizeTool(ev.tool ?? '?', ev.input),
        tool: ev.tool, toolUseId: ev.id, since: Date.now(),
      });
    case 'turn.start': {
      s = setWaiting(s, undefined);
      // endedAt: in folder scope another session may have ended while this one keeps going.
      s = reduce(s, { type: 'session.update', patch: { activity: 'working', endedAt: undefined } }).state;
      // A turn without a typed prompt (a continuation) adds no message.
      return ev.text ? cmd(s, 'conversation', 'user', { text: String(ev.text), id: ev.turnId }) : s;
    }
    case 'text':
      return cmd(s, 'conversation', 'chunk', { messageId: ev.id, index: 0, delta: String(ev.text ?? ''), final: !!ev.final });
    case 'tool.start':
      s = reduce(s, { type: 'session.update', patch: { activity: 'working' } }).state;
      if (ev.tool === 'AskUserQuestion') s = setWaiting(s, questionWait(ev.id, ev.input));
      // Web research shows up in the browser as it starts: the query, or the page being fetched.
      if (ev.tool === 'WebSearch' && ev.input?.query) s = web(s, ctx, 'web.search', { query: String(ev.input.query) });
      if (ev.tool === 'WebFetch' && ev.input?.url) s = web(s, ctx, 'web.page', { url: String(ev.input.url) });
      return cmd(s, 'terminal', 'tool.start', { id: ev.id, tool: ev.tool, input: ev.input });
    case 'tool.end': {
      const input = ev.input ?? {};
      if (endsWait(s.session.waiting, ev.id)) s = setWaiting(s, undefined);
      s = cmd(s, 'terminal', 'tool.end', {
        id: ev.id, tool: ev.tool, input, response: ev.error ? ev.error : ev.result,
        durationMs: ev.durationMs, error: ev.error ? true : undefined,
      });
      return ev.error ? s : applyToolSideEffects(s, ev.tool, input, ev.result, ctx, auto);
    }
    case 'turn.complete':
      s = reduce(s, { type: 'session.update', patch: { activity: 'idle', waiting: undefined } }).state;
      return cmd(s, 'conversation', 'turnEnd', {});
    case 'agent.end':
      return s;
    case 'session.end':
      return reduce(s, { type: 'session.update', patch: { endedAt: Date.now(), activity: 'idle', waiting: undefined } }).state;
    case 'session.start':
      s = reduce(s, { type: 'session.update', patch: { endedAt: undefined, cwd: ev.cwd ?? s.session.cwd } }).state;
      // A session joining a glass with history (folder scope, /clear, resume) gets a divider.
      if (ev.source && ev.source !== 'compact' && (s.appState.terminal as { entries?: unknown[] } | undefined)?.entries?.length) s = cmd(s, 'terminal', 'agent', { text: `── session ${ev.source}${ev.sessionId ? ` · ${String(ev.sessionId).slice(0, 8)}` : ''} ──` });
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
function autoWindow(s: GlassState, ctx: EventContext, opts: Parameters<typeof autoCommand>[1]): GlassState {
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

const web = (s: GlassState, ctx: EventContext, command: string, args: Record<string, unknown>) =>
  autoWindow(s, ctx, { id: 'browser', appType: 'browser', title: 'Browser', command, args, autoOpen: s.settings.autoOpen.web !== false });

function applyToolSideEffects(
  s: GlassState, tool: string, input: any, result: any, ctx: EventContext, auto: GlassState['settings']['autoOpen'],
): GlassState {
  const path: string | undefined = input.file_path;

  if (EDIT_TOOLS.has(tool) && path) {
    const patch = result?.structuredPatch;
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

  if (tool === 'WebSearch' && input.query && result) {
    s = web(s, ctx, 'web.search', { query: String(input.query), results: searchResults(result) });
  }

  if (tool === 'Read' && path && IMAGE_RE.test(path)) {
    const stored = ctx.ingestFile(path);
    if (stored) s = autoWindow(s, ctx, { id: 'images', appType: 'image', title: 'Images', command: 'add', args: { file: stored, name: path.split('/').pop(), source: path }, autoOpen: auto.images });
  }
  return s;
}
