import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { browser, normalizeEndpoint, type BrowserState } from '../../src/apps/browser';
import { messageText, type ConversationState } from '../../src/apps/conversation';
import type { DiffState } from '../../src/apps/diff';
import type { TerminalState } from '../../src/apps/terminal';
import { applyHook, type HookContext } from '../../src/core/hooks';
import { computeDesktops, effectiveLayout } from '../../src/core/layout';
import { diffLines } from '../../src/core/linediff';
import { initialState, reduce } from '../../src/core/reducer';
import type { GlassState } from '../../src/core/types';

const ctx: HookContext = { ingestFile: (p) => `/stored/${p.split('/').pop()}`, readText: () => '# plan from disk' };
const fresh = () => initialState({ id: 'test', cwd: '/tmp/proj' });
const fixtures = readFileSync(join(__dirname, '../fixtures/hook-payloads.ndjson'), 'utf8')
  .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

describe('layout', () => {
  it('slices one order across desktops by slot count', () => {
    const pages = computeDesktops(['a', 'b', 'c', 'd', 'e'], ['main-left'], 'split');
    expect(pages.map((p) => p.windows)).toEqual([['a', 'b', 'c'], ['d', 'e']]);
    expect(pages[1].layout).toBe('split');
    expect(pages[1].start).toBe(3);
  });
  it('always has one desktop and drops trailing empties', () => {
    expect(computeDesktops([], [], 'grid')).toHaveLength(1);
    expect(computeDesktops(['a'], ['full', 'grid', 'grid'], 'grid')).toHaveLength(1);
  });
  it('fills partially used desktops without holes', () => {
    const [p] = computeDesktops(['a'], ['grid'], 'grid');
    expect(effectiveLayout(p)).toBe('full');
  });
});

describe('reducer', () => {
  it('starts with conversation then terminal open', () => {
    const s = fresh();
    expect(s.order).toEqual(['conversation', 'terminal']);
  });
  it('opens new windows at index 0 and reopen moves to 0', () => {
    let s = fresh();
    s = reduce(s, { type: 'instance.create', appType: 'markdown' }).state;
    expect(s.order[0]).toBe('markdown-1');
    s = reduce(s, { type: 'window.close', id: 'markdown-1' }).state;
    expect(s.order).not.toContain('markdown-1');
    s = reduce(s, { type: 'window.open', id: 'terminal' }).state;
    expect(s.order[0]).toBe('terminal');
    s = reduce(s, { type: 'window.open', id: 'markdown-1' }).state;
    expect(s.order).toEqual(['markdown-1', 'terminal', 'conversation']);
  });
  it('moves windows by index and clamps', () => {
    let s = fresh();
    s = reduce(s, { type: 'window.move', id: 'conversation', index: 99 }).state;
    expect(s.order).toEqual(['terminal', 'conversation']);
  });
  it('pinned windows hold their slot while others flow around them', () => {
    let s = fresh(); // [conversation, terminal]
    s = reduce(s, { type: 'window.pin', id: 'conversation', index: 1 }).state;
    expect(s.order).toEqual(['terminal', 'conversation']);
    s = reduce(s, { type: 'instance.create', appType: 'markdown' }).state;
    expect(s.order).toEqual(['markdown-1', 'conversation', 'terminal']);
    s = reduce(s, { type: 'window.move', id: 'terminal', index: 0 }).state;
    expect(s.order).toEqual(['terminal', 'conversation', 'markdown-1']);
    s = reduce(s, { type: 'window.move', id: 'terminal', index: 1 }).state; // onto the pin: next free slot
    expect(s.order).toEqual(['markdown-1', 'conversation', 'terminal']);
    s = reduce(s, { type: 'window.close', id: 'markdown-1' }).state;
    expect(s.order).toEqual(['terminal', 'conversation']);
  });
  it('moving a pinned window re-pins it; pin past the end lands last; unpin and close clear it', () => {
    let s = fresh();
    s = reduce(s, { type: 'instance.create', appType: 'markdown' }).state; // [md, conv, term]
    s = reduce(s, { type: 'window.pin', id: 'markdown-1' }).state; // pins at current slot 0
    expect(s.pinned).toEqual({ 'markdown-1': 0 });
    s = reduce(s, { type: 'window.move', id: 'markdown-1', index: 2 }).state;
    expect(s.pinned).toEqual({ 'markdown-1': 2 });
    expect(s.order).toEqual(['conversation', 'terminal', 'markdown-1']);
    s = reduce(s, { type: 'window.close', id: 'terminal' }).state;
    expect(s.order).toEqual(['conversation', 'markdown-1']);
    s = reduce(s, { type: 'window.open', id: 'terminal' }).state;
    expect(s.order).toEqual(['terminal', 'conversation', 'markdown-1']);
    s = reduce(s, { type: 'window.pin', id: 'terminal', index: 2 }).state; // takes over the slot
    expect(s.pinned).toEqual({ terminal: 2 });
    s = reduce(s, { type: 'window.unpin', id: 'terminal' }).state;
    expect(s.pinned).toEqual({});
    s = reduce(s, { type: 'window.pin', id: 'terminal', index: 0 }).state;
    s = reduce(s, { type: 'window.close', id: 'terminal' }).state;
    expect(s.pinned).toEqual({});
  });
  it('singletons are never duplicated', () => {
    let s = fresh();
    const r = reduce(s, { type: 'instance.create', appType: 'terminal' });
    expect(r.result).toBe('terminal');
    expect(Object.keys(r.state.instances).filter((k) => k.startsWith('terminal'))).toEqual(['terminal']);
  });
  it('rejects unknown things with clear errors', () => {
    expect(() => reduce(fresh(), { type: 'window.open', id: 'nope' })).toThrow(/no such/);
    expect(() => reduce(fresh(), { type: 'instance.create', appType: 'nope' })).toThrow(/unknown app/);
    expect(() => reduce(fresh(), { type: 'desktop.layout', desktop: 0, layout: 'weird' as any })).toThrow(/layout/);
    expect(() => reduce(fresh(), { type: 'app.command', id: 'terminal', command: 'explode' })).toThrow(/unknown command/);
  });
  it('sets per-desktop layouts, extending the list', () => {
    const s = reduce(fresh(), { type: 'desktop.layout', desktop: 2, layout: 'grid' }).state;
    expect(s.desktops).toEqual(['main-left', 'main-left', 'grid']);
  });
});

describe('waiting on the user (synthetic payloads: not yet captured live)', () => {
  const sid = { session_id: 'test' };
  const ask = {
    ...sid, hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_use_id: 'q1',
    tool_input: { questions: [{ question: 'Which dock order?', header: 'Dock', options: [{ label: 'Windows', description: 'Tile order' }, { label: 'Fixed' }] }] },
  };
  it('AskUserQuestion shows a question until its PostToolUse', () => {
    let s = applyHook(fresh(), ask, ctx);
    expect(s.session.waiting).toMatchObject({ kind: 'question', summary: 'Which dock order?', toolUseId: 'q1' });
    expect(s.session.waiting!.questions![0].options.map((o) => o.label)).toEqual(['Windows', 'Fixed']);
    s = applyHook(s, { ...sid, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'other', tool_input: {} }, ctx);
    expect(s.session.waiting).toBeDefined(); // a parallel tool finishing doesn't clear it
    s = applyHook(s, { ...sid, hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_use_id: 'q1', tool_input: {} }, ctx);
    expect(s.session.waiting).toBeUndefined();
  });
  it('PermissionRequest and permission Notifications show a permission wait; Stop clears it', () => {
    let s = applyHook(fresh(), { ...sid, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm run e2e' } }, ctx);
    expect(s.session.waiting).toMatchObject({ kind: 'permission', summary: '$ npm run e2e', tool: 'Bash' });
    s = applyHook(s, { ...sid, hook_event_name: 'Stop' }, ctx);
    expect(s.session.waiting).toBeUndefined();
    s = applyHook(s, { ...sid, hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }, ctx);
    expect(s.session.waiting).toBeUndefined();
    s = applyHook(s, { ...sid, hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }, ctx);
    expect(s.session.waiting?.kind).toBe('permission');
    s = applyHook(s, { ...sid, hook_event_name: 'UserPromptSubmit', prompt: 'hi' }, ctx);
    expect(s.session.waiting).toBeUndefined();
  });
});

describe('hooks (real captured payloads)', () => {
  const run = () => fixtures.reduce((s: GlassState, p) => applyHook(s, p, ctx), fresh());

  it('builds conversation from prompt + streamed chunks', () => {
    const conv = run().appState.conversation as ConversationState;
    expect(conv.messages[0].role).toBe('user');
    expect(conv.messages.filter((m) => m.role === 'assistant').map(messageText)).toEqual([
      "I'll start by reading the file, then make the changes.",
      'All done—file updated and command executed.',
    ]);
    expect(conv.messages.every((m) => m.done)).toBe(true);
  });

  it('records every tool call in the terminal', () => {
    const term = run().appState.terminal as TerminalState;
    expect(term.entries.map((e) => e.tool)).toEqual(['Read', 'Edit', 'Bash', 'WebSearch', 'WebFetch']);
    expect(term.entries.every((e) => e.status === 'ok')).toBe(true);
    expect(term.entries[2].summary).toBe('$ echo done');
    expect(term.entries[2].output).toBe('done');
  });

  it('auto-opens the changes diff viewer once', () => {
    const s = run();
    expect(s.order).toContain('changes');
    const d = s.appState.changes as DiffState;
    expect(d.files).toHaveLength(1);
    expect(d.revisions[d.files[0]][0].hunks[0].lines).toEqual(['-hello world', '+goodbye world']);
    // user closes it; further edits don't reopen it
    let s2 = reduce(s, { type: 'window.close', id: 'changes' }).state;
    const edit = fixtures.find((p) => p.hook_event_name === 'PostToolUse' && p.tool_name === 'Edit');
    s2 = applyHook(s2, edit, ctx);
    expect(s2.order).not.toContain('changes');
    expect((s2.appState.changes as DiffState).revisions[d.files[0]]).toHaveLength(2);
  });

  it('assembles out-of-order chunks by index', () => {
    let s = fresh();
    const base = { hook_event_name: 'MessageDisplay', message_id: 'm1', turn_id: 't' };
    s = applyHook(s, { ...base, index: 1, delta: ' world', final: true }, ctx);
    s = applyHook(s, { ...base, index: 0, delta: 'hello', final: false }, ctx);
    const conv = s.appState.conversation as ConversationState;
    expect(conv.messages).toHaveLength(1);
    expect(messageText(conv.messages[0])).toBe('hello world');
  });

  it('shows plans and images automatically', () => {
    let s = fresh();
    s = applyHook(s, { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_use_id: 'w', tool_input: { file_path: '/p/plans/x.md', content: '# Plan\n- a' }, tool_response: {} }, ctx);
    expect((s.appState.plan as any).content).toBe('# Plan\n- a');
    s = applyHook(s, { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 'r', tool_input: { file_path: '/p/shot.png' }, tool_response: {} }, ctx);
    expect((s.appState.images as any).images[0].file).toBe('/stored/shot.png');
    expect(s.order.slice(0, 2)).toEqual(['images', 'plan']);
  });

  it('pre/post arriving out of order still yields one entry', () => {
    let s = fresh();
    s = applyHook(s, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'x', tool_input: { command: 'ls' }, tool_response: { stdout: 'a' } }, ctx);
    s = applyHook(s, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'x', tool_input: { command: 'ls' } }, ctx);
    const t = s.appState.terminal as TerminalState;
    expect(t.entries).toHaveLength(1);
    // a late PreToolUse must not flip a finished entry back to running
    expect(t.entries[0].status).toBe('ok');
  });
});

describe('linediff', () => {
  it('produces unified hunks with context', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].join('\n');
    const after = ['a', 'b', 'c', 'D', 'e', 'f', 'g', 'h', 'i', 'J'].join('\n');
    const h = diffLines(before, after);
    expect(h.length).toBeGreaterThanOrEqual(1);
    const all = h.flatMap((x) => x.lines);
    expect(all).toContain('-d');
    expect(all).toContain('+D');
    expect(all).toContain('+J');
  });
  it('handles creation', () => {
    const h = diffLines('', 'x\ny');
    expect(h[0].lines).toEqual(['+x', '+y']);
    expect(h[0].newStart).toBe(1);
  });
});

describe('browser app', () => {
  it('accepts local CDP endpoints only', () => {
    expect(normalizeEndpoint('9222')).toBe('http://127.0.0.1:9222');
    expect(normalizeEndpoint('localhost:9333')).toBe('http://localhost:9333');
    expect(normalizeEndpoint('ws://127.0.0.1:9222/devtools/browser/x')).toBe('http://127.0.0.1:9222');
    expect(() => normalizeEndpoint('http://evil.example:9222')).toThrow(/this machine/);
  });
  it('attach → status → detach; stale status after detach is ignored', () => {
    let s = browser.command(browser.init(), 'attach', {});
    expect(s).toMatchObject({ endpoint: 'http://127.0.0.1:9222', status: 'waiting' });
    s = browser.command(s, 'status', { status: 'live', url: 'https://a.test/', title: 'A' });
    expect(s).toMatchObject({ status: 'live', url: 'https://a.test/', title: 'A' });
    expect(browser.command(s, 'status', { status: 'live', url: 'https://a.test/', title: 'A' })).toBe(s);
    s = browser.command(s, 'detach', {});
    expect(browser.command(s, 'status', { status: 'live' })).toBe(s);
  });
  it('frame shows a pushed screenshot and stops streaming', () => {
    const s = browser.command(browser.command(browser.init(), 'attach', {}), 'frame', { file: '/f/shot.png', url: 'https://b.test/' });
    expect(s).toMatchObject({ view: 'shot', shot: { file: '/f/shot.png', url: 'https://b.test/' } });
  });
  it('web research: the query first, then results; a fetched page takes over; cdp navigation takes it back', () => {
    const web = fixtures.filter((p) => p.tool_name === 'WebSearch' || p.tool_name === 'WebFetch');
    let s = fresh();
    s = applyHook(s, web[0], ctx); // PreToolUse WebSearch
    const b = () => s.appState.browser as BrowserState;
    expect(s.order[0]).toBe('browser'); // auto-opened
    expect(b().web).toMatchObject({ kind: 'search', query: 'Chrome DevTools Protocol Page.startScreencast', results: null });
    s = applyHook(s, web[3], ctx); // PostToolUse WebSearch
    expect((b().web as any).results[0]).toEqual({ title: expect.stringContaining('Background transparency'), url: 'https://github.com/ChromeDevTools/devtools-protocol/issues/162' });
    s = applyHook(s, web[1], ctx); // PreToolUse WebFetch
    expect(b()).toMatchObject({ view: 'web', web: { kind: 'page', url: 'https://chromedevtools.github.io/devtools-protocol/tot/Page/' } });
    s = reduce(s, { type: 'app.command', id: 'browser', command: 'attach', args: {} }).state;
    s = reduce(s, { type: 'app.command', id: 'browser', command: 'web.page', args: { url: 'https://x.test/' } }).state;
    expect(b().view).toBe('web');
    s = reduce(s, { type: 'app.command', id: 'browser', command: 'status', args: { status: 'live', url: 'https://app.test/', title: 'App' } }).state;
    expect(b().view).toBe('cdp');
  });
});
