import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findProjectImages } from '../../src/core/projectImages';
import { installedGlass, pendingUpdate } from '../../src/core/update';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browser, currentWeb, normalizeEndpoint, type BrowserState } from '../../src/apps/browser';
import { coerceSetting, parsePermissions, parseSettingSpecs, settingValues } from '../../src/apps/types';
import { messageText, type ConversationState } from '../../src/apps/conversation';
import type { DiffState } from '../../src/apps/diff';
import type { TerminalState } from '../../src/apps/terminal';
import { applyHook, type HookContext } from '../../src/core/hooks';
import { DEFAULT_PALETTES, lightColors, moodOf, parsePalettes } from '../../src/core/colors';
import { healthReport } from '../../src/core/health';
import { capturePreset, presetActions } from '../../src/core/presets';
import { DEFAULT_CONFIG } from '../../src/core/config';
import { computeDesktops, effectiveLayout, nestedSlots } from '../../src/core/layout';
import { guideFor, guideForSettings } from '../../src/core/guide';
import { attachBuiltinViews, loadMods } from '../../src/core/mods';
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

describe('nested layout', () => {
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

describe('history mode', () => {
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
  it('keeps only the newest historyLimit windows; pinned ones survive', () => {
    let s = reduce(fresh(), { type: 'settings.set', key: 'historyLimit', value: 3 }).state;
    s = applyHook(s, editAs('toolu_P0'), hctx);
    s = reduce(s, { type: 'window.tuck', id: 'changes-tooluP0', edge: 'left' }).state;
    for (let i = 1; i <= 5; i++) s = applyHook(s, editAs(`toolu_E${i}`), hctx);
    const kept = Object.keys(s.instances).filter((id) => id.startsWith('changes-'));
    expect(kept.sort()).toEqual(['changes-tooluE3', 'changes-tooluE4', 'changes-tooluE5', 'changes-tooluP0']);
    expect(s.order).not.toContain('changes-tooluE1');
  });
});

describe('app guides by setting', () => {
  it('keeps when-blocks only for matching settings; text outside blocks always', () => {
    const g = 'Always.\n<!-- when windowMode=live -->\nReuse one window.\n<!-- when windowMode=history -->\nOne per action.\n<!-- end -->\nTail.';
    expect(guideForSettings(g, { windowMode: 'live' })).toBe('Always.\nReuse one window.\nTail.');
    expect(guideForSettings(g, { windowMode: 'history' })).toBe('Always.\nOne per action.\nTail.');
  });
  it('the images guide asks to reuse one window only in live mode', () => {
    attachBuiltinViews(join(__dirname, '../../dist/apps')); // built-ins read their guide.md from the build
    expect(guideFor({ defaultLayout: 'grid', windowMode: 'live' })).toContain('Images live in one window');
    expect(guideFor({ defaultLayout: 'grid', windowMode: 'history' })).not.toContain('Images live in one window');
  });
  it('images: grid view is a saved view option; opening a tile goes back to single', () => {
    const img = APPS.image;
    let s = img.command(img.init(), 'add', { file: '/a.png' }) as any;
    s = img.command(s, 'add', { file: '/b.png' });
    s = img.command(s, 'view', { mode: 'grid' });
    expect(s.view).toBe('grid');
    s = img.command(s, 'add', { file: '/c.png' });
    expect(s.view).toBe('grid');
    s = img.command(s, 'select', { index: 0, single: true });
    expect(s).toMatchObject({ view: 'single', index: 0 });
    expect(() => img.command(s, 'view', { mode: 'mosaic' })).toThrow();
  });
});

describe('app settings', () => {
  it('manifest specs are validated; values coerce and fall back to defaults', () => {
    const specs = parseSettingSpecs({
      gridSize: { type: 'number', label: 'Grid', default: 12, min: 2, max: 40 },
      compact: { type: 'bool', label: 'Compact', default: false },
      theme: { type: 'enum', label: 'Theme', default: 'dark', options: ['dark', 'light'] },
    })!;
    expect(coerceSetting(specs.gridSize, '8')).toBe(8);
    expect(() => coerceSetting(specs.gridSize, '99')).toThrow(/between/);
    expect(coerceSetting(specs.compact, 'true')).toBe(true);
    expect(() => coerceSetting(specs.theme, 'neon')).toThrow(/one of/);
    expect(settingValues({ settings: specs }, { gridSize: 4, theme: 'neon' })).toEqual({ gridSize: 4, compact: false, theme: 'dark' });
    expect(() => parseSettingSpecs({ 'bad-key': { type: 'bool', label: 'x', default: true } })).toThrow(/letters/);
    expect(() => parseSettingSpecs({ n: { type: 'number', label: 'x', default: 50, max: 10 } })).toThrow(/between/);
    expect(() => parseSettingSpecs({ e: { type: 'enum', label: 'x', default: 'a' } })).toThrow(/options/);
  });
  it("an app's guide can depend on its own settings", () => {
    expect(guideForSettings('A\n<!-- when compact=true -->\nB\n<!-- end -->', { compact: 'false' })).toBe('A');
  });
});

describe('state colors', () => {
  it('mood follows the session; Claude\'s signal wins, then the state palette, then the user\'s own', () => {
    expect(moodOf({ activity: 'working' })).toBe('working');
    expect(moodOf({ activity: 'working', waiting: { kind: 'question' } })).toBe('waiting');
    expect(moodOf({ activity: 'idle' })).toBe('idle');
    expect(moodOf({ activity: 'idle', endedAt: 1 })).toBe('ended');
    const palettes = parsePalettes({ waiting: '#e0a030' });
    expect(palettes.waiting).toEqual(['#e0a030']);
    expect(palettes.idle).toEqual(DEFAULT_PALETTES.idle);
    const base = { stateColors: true, palettes, own: ['#112233'] };
    expect(lightColors({ ...base, mood: 'waiting' })).toEqual(['#e0a030']);
    expect(lightColors({ ...base, mood: 'working' })).toEqual(['#112233']); // working: [] = own
    expect(lightColors({ ...base, mood: 'waiting', signal: ['#c0392b'] })).toEqual(['#c0392b']);
    expect(lightColors({ ...base, stateColors: false, mood: 'waiting' })).toEqual(['#112233']);
    expect(() => parsePalettes({ angry: ['#f00'] })).toThrow(/unknown mood/);
    expect(() => parsePalettes('{"idle":["url(x)"]}')).toThrow(/hex/);
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

describe('presets', () => {
  it('capture a frame, and turn it back into reducer actions on another glass', () => {
    let a = fresh();
    a = reduce(a, { type: 'window.tuck', id: 'terminal', edge: 'bottom' }).state;
    a = reduce(a, { type: 'tuck.keep', edge: 'bottom', keep: true }).state;
    a = reduce(a, { type: 'tuck.size', edge: 'bottom', size: 300 }).state;
    a = reduce(a, { type: 'settings.set', key: 'windowMode', value: 'history' }).state;
    const p = capturePreset(a, { ...DEFAULT_CONFIG, nestedView: true }, 'frame', 'terminal along the bottom');
    expect(p.sidebars?.bottom).toMatchObject({ windows: [{ id: 'terminal', type: 'terminal' }], open: true, size: 300 });
    expect(p.look?.nestedView).toBe(true);
    // A glass with the conversation pinned left instead: that goes back to the layout.
    let b = reduce(fresh(), { type: 'window.tuck', id: 'conversation', edge: 'left' }).state;
    const { actions, skipped } = presetActions(b, { ...p, sidebars: { ...p.sidebars, right: { windows: [{ id: 'vmux', type: 'vmux' }] } } }, (t) => t !== 'vmux');
    for (const act of actions) b = reduce(b, act).state;
    expect(b.tucked?.bottom).toEqual(['terminal']);
    expect(b.tucked?.left ?? []).toEqual([]);
    expect(b.order).toContain('conversation');
    expect(b.tuckKeep).toContain('bottom');
    expect(b.tuckSize?.bottom).toBe(300);
    expect(b.settings.windowMode).toBe('history');
    expect(skipped).toEqual(['vmux (vmux)']);
  });
  it('carry corner docks with both dimensions', () => {
    let a = reduce(fresh(), { type: 'window.tuck', id: 'terminal', edge: 'top-left' }).state;
    a = reduce(a, { type: 'tuck.size', edge: 'top-left', size: 320, height: 210 }).state;
    const p = capturePreset(a, DEFAULT_CONFIG, 'corner');
    expect(p.sidebars?.['top-left']).toMatchObject({ size: 320, height: 210, open: false });
    let b = fresh();
    for (const act of presetActions(b, p, () => true).actions) b = reduce(b, act).state;
    expect(b.tucked?.['top-left']).toEqual(['terminal']);
    expect([b.tuckSize?.['top-left'], b.tuckHeight?.['top-left']]).toEqual([320, 210]);
  });
});

describe('signals', () => {
  it('one at a time; spotlight and alert need a window; progress ends at 1; clear removes it', () => {
    let s = reduce(fresh(), { type: 'signal', kind: 'spotlight', target: 'terminal' }).state;
    expect(s.signal).toMatchObject({ kind: 'spotlight', target: 'terminal', seq: 1 });
    s = reduce(s, { type: 'signal', kind: 'spotlight', target: 'terminal' }).state;
    expect(s.signal?.seq).toBe(2); // a repeat replays
    expect(() => reduce(s, { type: 'signal', kind: 'alert' })).toThrow(/needs a window/);
    expect(() => reduce(s, { type: 'signal', kind: 'alert', target: 'nope' })).toThrow(/no such window/);
    expect(() => reduce(s, { type: 'signal', kind: 'glow' as any })).toThrow(/spotlight, alert, progress or clear/);
    s = reduce(s, { type: 'signal', kind: 'progress', value: 0.4, label: 'Migrating' }).state;
    expect(s.signal).toMatchObject({ kind: 'progress', value: 0.4, label: 'Migrating' });
    expect(reduce(s, { type: 'signal', kind: 'progress', value: 1 }).state.signal).toBeUndefined();
    expect(reduce(s, { type: 'signal', kind: 'clear' }).state.signal).toBeUndefined();
    // A signal at a window that's deleted goes with it.
    let t = reduce(fresh(), { type: 'instance.create', appType: 'markdown', id: 'notes' }).state;
    t = reduce(t, { type: 'signal', kind: 'alert', target: 'notes' }).state;
    expect(reduce(t, { type: 'instance.delete', id: 'notes' }).state.signal).toBeUndefined();
  });
});

describe('updates', () => {
  it('an older plugin install sees the new version; the current one and a checkout never do', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cg-plugins-'));
    const ver = (v: string) => { const root = join(dir, 'cache', 'n33kos', 'claude-glass', v); mkdirSync(join(root, 'bin'), { recursive: true }); writeFileSync(join(root, 'bin', 'claude-glass'), ''); return root; };
    const old = ver('1.4.0'), now = ver('1.4.1');
    writeFileSync(join(dir, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'claude-glass@n33kos': [{ scope: 'user', installPath: now, version: '1.4.1' }] } }));
    expect(pendingUpdate(old, dir)).toEqual({ version: '1.4.1', root: now });
    expect(pendingUpdate(now, dir)).toBeNull();
    expect(pendingUpdate('/Users/someone/claude-glass', dir)).toBeNull(); // a dev checkout
    expect(installedGlass(join(dir, 'nowhere'))).toBeNull();
  });
  it("an older version's launcher runs the installed version's CLI; the installed one runs its own", () => {
    const config = mkdtempSync(join(tmpdir(), 'cg-config-'));
    const launcher = readFileSync(join(__dirname, '../../bin/claude-glass'), 'utf8');
    const ver = (v: string) => {
      const root = join(config, 'plugins', 'cache', 'n33kos', 'claude-glass', v);
      mkdirSync(join(root, 'bin'), { recursive: true });
      mkdirSync(join(root, 'dist'), { recursive: true });
      writeFileSync(join(root, 'bin', 'claude-glass'), launcher);
      writeFileSync(join(root, 'dist', 'cli.js'), `console.log('${v}', process.argv.slice(2).join(' '))`);
      return root;
    };
    const old = ver('1.3.1'), now = ver('2.0.0');
    writeFileSync(join(config, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'claude-glass@n33kos': [{ scope: 'user', installPath: now, version: '2.0.0' }] } }));
    const run = (root: string) => execFileSync(process.execPath, [join(root, 'bin', 'claude-glass'), 'open', '--x'], { env: { ...process.env, CLAUDE_CONFIG_DIR: config, CLAUDE_GLASS_FORWARDED: '' }, encoding: 'utf8' }).trim();
    expect(run(old)).toBe('2.0.0 open --x');
    expect(run(now)).toBe('2.0.0 open --x');
    // A record pointing back at the old folder still ends in one CLI, not a loop.
    writeFileSync(join(config, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'claude-glass@n33kos': { installPath: old, version: '1.3.1' } } }));
    expect(run(now)).toBe('1.3.1 open --x');
  });
});

describe('project images', () => {
  it('finds images newest first, skipping dependency, build and hidden folders', () => {
    const root = mkdtempSync(join(tmpdir(), 'cg-imgs-'));
    for (const d of ['docs', 'node_modules/x', '.git', 'dist']) mkdirSync(join(root, d), { recursive: true });
    for (const f of ['old.png', 'docs/new.jpg', 'docs/notes.md', 'node_modules/x/dep.png', '.git/g.png', 'dist/built.png']) writeFileSync(join(root, f), 'x');
    utimesSync(join(root, 'old.png'), 1000, 1000);
    const found = findProjectImages(root);
    expect(found.map((i) => i.rel)).toEqual(['docs/new.jpg', 'old.png']);
    expect(findProjectImages(root, { max: 1 })).toHaveLength(1);
    expect(findProjectImages('')).toEqual([]);
  });
  it('a new glass has one Images window, closed; showing an image switches it to the Shown list', () => {
    const s = fresh();
    expect(s.instances.images?.type).toBe('image');
    expect(s.order).not.toContain('images');
    let st = APPS.image.command(APPS.image.init(), 'view', { source: 'project' }) as any;
    expect(st.source).toBe('project');
    st = APPS.image.command(st, 'add', { file: '/a.png' });
    expect(st.source).toBe('shown');
    expect(() => APPS.image.command(st, 'view', { source: 'desk' })).toThrow(/shown\|project/);
  });
});

describe('health report', () => {
  it('summarizes the latest run: memory per process type, growth, crashes', () => {
    const s = (min: number, gpu: number) => JSON.stringify({ t: 'x', kind: 'sample', uptimeMin: min, procs: { gpu: { n: 1, mb: gpu, cpu: 2 }, renderer: { n: 3, mb: 300, cpu: 1 } }, mainHeapMB: 20, sys: { freeMB: 900, load1: 1.5 }, windows: 7 });
    const log = [
      JSON.stringify({ t: 'x', kind: 'start' }), s(1, 999),
      JSON.stringify({ t: 'y', kind: 'start' }), s(1, 180), s(60, 240),
      JSON.stringify({ t: 'z', kind: 'child-gone', type: 'GPU', reason: 'crashed', exitCode: 5 }),
    ].join('\n');
    const r = healthReport(log);
    expect(r).toMatch(/gpu ×1\s+240\s+\+60\s+240/);
    expect(r).toContain('windows 7');
    expect(r).toContain('GPU crashed (exit 5)');
    expect(healthReport('')).toContain('No samples yet');
  });
});

describe('sidebar splits', () => {
  it('shares are normalized, one per window; wrong counts are refused', () => {
    let s = fresh();
    s = reduce(s, { type: 'window.tuck', id: 'terminal', edge: 'right' }).state;
    expect(() => reduce(s, { type: 'tuck.split', edge: 'right', shares: [1] })).toThrow(/positive shares/);
    s = reduce(s, { type: 'window.tuck', id: 'conversation', edge: 'right' }).state;
    s = reduce(s, { type: 'tuck.split', edge: 'right', shares: [3, 1] }).state;
    expect(s.tuckSplit?.right).toEqual([0.75, 0.25]);
    expect(() => reduce(s, { type: 'tuck.split', edge: 'right', shares: [1, 0] })).toThrow();
  });
});

describe('edge sidebars', () => {
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
  it('delete removes a window everywhere; terminal and conversation can only be closed', () => {
    let s = reduce(fresh(), { type: 'instance.create', appType: 'markdown', id: 'notes' }).state;
    s = reduce(s, { type: 'window.tuck', id: 'notes', edge: 'top' }).state;
    s = reduce(s, { type: 'instance.delete', id: 'notes' }).state;
    expect(s.instances.notes).toBeUndefined();
    expect(s.appState.notes).toBeUndefined();
    expect(s.tucked?.top).toBeUndefined();
    expect(() => reduce(s, { type: 'instance.delete', id: 'terminal' })).toThrow(/closed but not deleted/);
  });
  it('an edge kept open stays open only while it has windows', () => {
    let s = reduce(fresh(), { type: 'window.tuck', id: 'terminal', edge: 'right' }).state;
    s = reduce(s, { type: 'tuck.keep', edge: 'right', keep: true }).state;
    expect(s.tuckKeep).toEqual(['right']);
    expect(reduce(s, { type: 'tuck.keep', edge: 'left', keep: true }).state.tuckKeep).toEqual(['right']); // empty edge
    s = reduce(s, { type: 'window.untuck', id: 'terminal' }).state;
    expect(s.tuckKeep).toEqual([]);
  });
  it('corner docks take windows like edges, and sizes in both directions (height: corners only)', () => {
    let s = reduce(fresh(), { type: 'window.tuck', id: 'terminal', edge: 'bottom-right' }).state;
    expect(s.tucked).toEqual({ 'bottom-right': ['terminal'] });
    expect(s.order).not.toContain('terminal');
    s = reduce(s, { type: 'tuck.keep', edge: 'bottom-right', keep: true }).state;
    s = reduce(s, { type: 'tuck.size', edge: 'bottom-right', size: 300, height: 220 }).state;
    expect(s.tuckSize?.['bottom-right']).toBe(300);
    expect(s.tuckHeight?.['bottom-right']).toBe(220);
    s = reduce(s, { type: 'tuck.size', edge: 'bottom-right', height: 260 }).state; // one dimension alone
    expect([s.tuckSize?.['bottom-right'], s.tuckHeight?.['bottom-right']]).toEqual([300, 260]);
    expect(() => reduce(s, { type: 'tuck.size', edge: 'left', height: 200 })).toThrow(/corner/);
    expect(() => reduce(s, { type: 'window.tuck', id: 'conversation', edge: 'middle' as any })).toThrow(/dock must be one of/);
    s = reduce(s, { type: 'window.tuck', id: 'terminal', edge: 'left' }).state; // moving docks
    expect(s.tucked).toEqual({ left: ['terminal'] });
    expect(s.tuckKeep).toEqual([]);
  });
});
