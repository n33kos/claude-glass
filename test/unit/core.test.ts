import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browser, currentWeb, normalizeEndpoint, type BrowserState } from '../../src/apps/browser';
import { parsePermissions } from '../../src/apps/types';
import { messageText, type ConversationState } from '../../src/apps/conversation';
import type { DiffState } from '../../src/apps/diff';
import type { TerminalState } from '../../src/apps/terminal';
import { applyHook, type HookContext } from '../../src/core/hooks';
import { computeDesktops, effectiveLayout, nestedSlots } from '../../src/core/layout';
import { guideFor } from '../../src/core/guide';
import { loadMods } from '../../src/core/mods';
import { APPS } from '../../src/apps/registry';
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
    expect(currentWeb(b())).toMatchObject({ kind: 'search', query: 'Chrome DevTools Protocol Page.startScreencast', results: null });
    s = applyHook(s, web[3], ctx); // PostToolUse WebSearch
    expect(b().history).toHaveLength(1); // results fill in the pending search, no new entry
    expect((currentWeb(b()) as any).results[0]).toEqual({ title: expect.stringContaining('Background transparency'), url: 'https://github.com/ChromeDevTools/devtools-protocol/issues/162' });
    s = applyHook(s, web[1], ctx); // PreToolUse WebFetch
    expect(b().view).toBe('web');
    expect(currentWeb(b())).toMatchObject({ kind: 'page', url: 'https://chromedevtools.github.io/devtools-protocol/tot/Page/' });
    s = reduce(s, { type: 'app.command', id: 'browser', command: 'attach', args: {} }).state;
    s = reduce(s, { type: 'app.command', id: 'browser', command: 'web.page', args: { url: 'https://x.test/' } }).state;
    expect(b().view).toBe('web');
    s = reduce(s, { type: 'app.command', id: 'browser', command: 'status', args: { status: 'live', url: 'https://app.test/', title: 'App' } }).state;
    expect(b().view).toBe('cdp');
  });
});

describe('browser history', () => {
  const cmd = (s: BrowserState, command: string, args: Record<string, unknown> = {}) => browser.command(s, command, args);
  it('walks back and forward; new activity jumps to the latest', () => {
    let s = browser.init();
    s = cmd(s, 'web.search', { query: 'q1' });
    s = cmd(s, 'web.page', { url: 'https://a.test/' });
    s = cmd(s, 'web.page', { url: 'https://a.test/' }); // repeat fetch: no duplicate
    s = cmd(s, 'web.page', { url: 'https://b.test/' });
    expect(s.history.map((h) => (h.kind === 'page' ? h.url : h.query))).toEqual(['q1', 'https://a.test/', 'https://b.test/']);
    s = cmd(s, 'web.go', { index: 0 });
    expect(currentWeb(s)).toMatchObject({ kind: 'search', query: 'q1' });
    s = cmd(s, 'web.title', { url: 'https://a.test/', title: 'A' });
    expect(s.history[1]).toMatchObject({ title: 'A' });
    s = cmd(s, 'web.page', { url: 'https://c.test/' });
    expect(s.cursor).toBe(-1);
    expect(currentWeb(s)).toMatchObject({ url: 'https://c.test/' });
  });
  it('going back from the live browser shows web history', () => {
    let s = cmd(cmd(browser.init(), 'web.page', { url: 'https://a.test/' }), 'attach', {});
    expect(s.view).toBe('cdp');
    s = cmd(s, 'web.go', { index: 0 });
    expect(s.view).toBe('web');
  });
});

describe('"Claude decides" layout', () => {
  it('fits new desktops to the windows left; explicit layouts win', () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`);
    expect(computeDesktops(ids(3), [], 'claude').map((p) => p.layout)).toEqual(['main-left']);
    expect(computeDesktops(ids(6), [], 'claude').map((p) => p.layout)).toEqual(['grid', 'split']);
    expect(computeDesktops(ids(6), ['full'], 'claude').map((p) => p.layout)).toEqual(['full', 'grid', 'full']);
  });
  it('tells Claude to pick layouts only in that mode', () => {
    expect(guideFor({ defaultLayout: 'claude' })).toContain('Layouts are yours to pick');
    expect(guideFor({ defaultLayout: 'grid' })).not.toContain('Layouts are yours to pick');
  });
});

describe('custom apps (mods)', () => {
  let reports: ReturnType<typeof loadMods> = [];
  beforeAll(() => { reports = loadMods(join(__dirname, '../fixtures/mods')); });
  afterAll(() => { for (const r of reports) if (r.ok) delete APPS[r.type]; });
  it('loads good mods and reports broken ones without throwing', () => {
    expect(reports.find((r) => r.type === 'tool-count')).toMatchObject({ ok: true });
    expect(reports.find((r) => r.type === 'broken')).toMatchObject({ ok: false, error: expect.stringContaining('command()') });
    expect(APPS['tool-count']).toMatchObject({ source: 'user', singleton: true, icon: '#' });
  });
  it('onHook creates, auto-opens and fills a singleton from hooks', () => {
    let s = fresh();
    for (const p of fixtures) s = applyHook(s, p, ctx);
    expect(s.order).toContain('tool-count');
    expect((s.appState['tool-count'] as any).counts).toMatchObject({ Read: 1, Edit: 1, Bash: 1 });
  });
  it('mod commands run through the reducer; guide lands in Claude’s instructions', () => {
    let s = reduce(fresh(), { type: 'instance.create', appType: 'tool-count' }).state;
    s = reduce(s, { type: 'app.command', id: 'tool-count', command: 'note', args: { text: 'hi' } }).state;
    expect((s.appState['tool-count'] as any).note).toBe('hi');
    expect(guideFor({ defaultLayout: 'grid' })).toContain('## Tool count (`tool-count`)');
  });
});

describe('disabled apps', () => {
  it('hooks leave turned-off apps untouched (no auto-created windows, no state changes)', () => {
    const ctxOff: HookContext = { ...ctx, disabled: new Set(['diff', 'terminal']) };
    let s = fresh();
    const term = s.appState.terminal;
    for (const p of fixtures) s = applyHook(s, p, ctxOff);
    expect(s.instances.changes).toBeUndefined();
    expect(s.order).not.toContain('changes');
    expect(s.appState.terminal).toBe(term);
    expect((s.appState.conversation as ConversationState).messages.length).toBeGreaterThan(0);
  });
});

describe('browser highlight and browsing', () => {
  const cmd = (s: BrowserState, command: string, args: Record<string, unknown> = {}) => browser.command(s, command, args);
  it('highlights the last fetched page and jumps to it', () => {
    let s = cmd(cmd(browser.init(), 'web.page', { url: 'https://a.test/' }), 'web.search', { query: 'q' });
    s = cmd(s, 'highlight', { text: '  the   key  passage ' });
    expect(s.cursor).toBe(0);
    expect(currentWeb(s)).toMatchObject({ kind: 'page', highlight: 'the key passage' });
    s = cmd(s, 'web.found', { url: 'https://a.test/', matches: 2 });
    expect(currentWeb(s)).toMatchObject({ found: 2 });
    expect(() => cmd(browser.init(), 'highlight', { text: 'x' })).toThrow(/no page/);
  });
  it('browsing away and back is view state; home bumps homeSeq', () => {
    let s = cmd(browser.init(), 'web.page', { url: 'https://a.test/' });
    s = cmd(s, 'web.away', { url: 'https://b.test/' });
    expect(s.away).toBe('https://b.test/');
    const seq = s.homeSeq ?? 0;
    s = cmd(s, 'web.home');
    expect(s.away).toBeNull();
    expect(s.homeSeq).toBe(seq + 1);
  });
});

describe('nested layout (experiment)', () => {
  it('spirals: each pane is half of what is left, capped at 6, filling the screen', () => {
    const s = nestedSlots(8);
    expect(s).toHaveLength(6);
    expect(s[0]).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
    expect(s[1]).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.5 });
    const area = s.reduce((a, r) => a + r.w * r.h, 0);
    expect(area).toBeCloseTo(1);
    expect(nestedSlots(1)).toEqual([{ x: 0, y: 0, w: 1, h: 1 }]);
  });
  it('a nested desktop takes every window', () => {
    const ids = Array.from({ length: 9 }, (_, i) => `w${i}`);
    const pages = computeDesktops(ids, ['nested'], 'grid');
    expect(pages).toHaveLength(1);
    expect(pages[0].windows).toHaveLength(9);
  });
});

describe('history mode (experiment)', () => {
  const hctx: HookContext = { ...ctx, windowMode: 'history' };
  const edit = fixtures.find((p) => p.hook_event_name === 'PostToolUse' && p.tool_name === 'Edit');
  const editAs = (id: string) => ({ ...edit, tool_use_id: id });
  it('every action gets its own window, newest at slot 0', () => {
    let s = applyHook(applyHook(fresh(), editAs('toolu_A1'), hctx), editAs('toolu_B2'), hctx);
    expect(s.order.slice(0, 2)).toEqual(['changes-tooluB2', 'changes-tooluA1']);
    expect(s.instances['changes-tooluB2'].title).toBe('Changes');
  });
  it("a search's start and results share one browser window", () => {
    const web = fixtures.filter((p) => p.tool_name === 'WebSearch');
    let s = fresh();
    for (const p of web) s = applyHook(s, p, hctx);
    const browsers = Object.values(s.instances).filter((i) => i.type === 'browser');
    expect(browsers).toHaveLength(1);
    expect((s.appState[browsers[0].id] as BrowserState).history[0]).toMatchObject({ kind: 'search', results: expect.any(Array) });
  });

});

describe('app permissions', () => {
  it('none by default; explicit origins only', () => {
    expect(parsePermissions(undefined)).toEqual({ network: [], microphone: false, storage: false });
    expect(parsePermissions({ network: ['http://127.0.0.1:3100/api', 'ws://127.0.0.1:3100'], microphone: true, storage: true }))
      .toEqual({ network: ['http://127.0.0.1:3100', 'ws://127.0.0.1:3100'], microphone: true, storage: true });
    expect(() => parsePermissions({ network: ['*'] })).toThrow();
    expect(() => parsePermissions({ network: ['file:///etc'] })).toThrow(/origin/);
    expect(() => parsePermissions({ network: ['https://*.example.com'] })).toThrow();
  });
});

describe('edge tucking (experiment)', () => {
  it('tucking takes a window out of the flow; untuck puts it back first', () => {
    let s = reduce(fresh(), { type: 'instance.create', appType: 'markdown', id: 'notes' }).state;
    s = reduce(s, { type: 'window.tuck', id: 'notes', edge: 'left' }).state;
    expect(s.order).not.toContain('notes');
    expect(s.tucked?.left).toEqual(['notes']);
    s = reduce(s, { type: 'window.open', id: 'notes' }).state; // already on screen: stays tucked
    expect(s.order).not.toContain('notes');
    s = reduce(s, { type: 'window.tuck', id: 'terminal', edge: 'left' }).state;
    expect(s.tucked?.left).toEqual(['notes', 'terminal']);
    s = reduce(s, { type: 'window.tuck', id: 'notes', edge: 'bottom' }).state; // moving edges
    expect(s.tucked).toEqual({ left: ['terminal'], bottom: ['notes'] });
    s = reduce(s, { type: 'window.untuck', id: 'notes' }).state;
    expect(s.order[0]).toBe('notes');
    s = reduce(s, { type: 'window.close', id: 'terminal' }).state;
    expect(s.tucked).toEqual({});
  });
  it('pins at a position, reorders within a sidebar (staying open), and unpins into a slot', () => {
    let s = reduce(fresh(), { type: 'window.tuck', id: 'terminal', edge: 'left' }).state;
    s = reduce(s, { type: 'window.tuck', id: 'conversation', edge: 'left', index: 0 }).state;
    expect(s.tucked?.left).toEqual(['conversation', 'terminal']);
    s = reduce(s, { type: 'tuck.keep', edge: 'left', keep: true }).state;
    s = reduce(s, { type: 'window.tuck', id: 'conversation', edge: 'left', index: 1 }).state; // reorder
    expect(s.tucked?.left).toEqual(['terminal', 'conversation']);
    expect(s.tuckKeep).toEqual(['left']);
    s = reduce(s, { type: 'instance.create', appType: 'markdown', id: 'notes' }).state;
    s = reduce(s, { type: 'window.untuck', id: 'terminal', index: 1 }).state;
    expect(s.order).toEqual(['notes', 'terminal']);
  });
  it('an edge kept open stays open only while it has windows', () => {
    let s = reduce(fresh(), { type: 'window.tuck', id: 'terminal', edge: 'right' }).state;
    s = reduce(s, { type: 'tuck.keep', edge: 'right', keep: true }).state;
    expect(s.tuckKeep).toEqual(['right']);
    expect(reduce(s, { type: 'tuck.keep', edge: 'left', keep: true }).state.tuckKeep).toEqual(['right']); // empty edge
    s = reduce(s, { type: 'window.untuck', id: 'terminal' }).state;
    expect(s.tuckKeep).toEqual([]);
  });
});
