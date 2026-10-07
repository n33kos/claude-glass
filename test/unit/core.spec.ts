import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findProjectImages } from '../../src/core/projectImages';
import { installedGlass, ownVersion, pendingUpdate } from '../../src/core/update';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browser, currentWeb, normalizeEndpoint, type BrowserState } from '../../src/apps/browser';
import { coerceSetting, parsePermissions, parseSettingSpecs, settingValues } from '../../src/apps/types';
import { messageText, type ConversationState } from '../../src/apps/conversation';
import type { DiffState } from '../../src/apps/diff';
import type { TerminalState } from '../../src/apps/terminal';
import { applyEvent, type EventContext, type GlassEvent } from '../../src/core/events';
import { DEFAULT_PALETTES, lightColors, moodOf, parsePalettes } from '../../src/core/colors';
import { healthReport } from '../../src/core/health';
import { capturePreset, presetActions } from '../../src/core/presets';
import { DEFAULT_CONFIG } from '../../src/core/config';
import { computeDesktops, effectiveLayout, nestedSlots } from '../../src/core/layout';
import { guideFor, guideForSettings } from '../../src/core/guide';
import { isAppOff } from '../../src/core/appset';
import { attachBuiltinViews, loadApps, readApp } from '../../src/core/customApps';
import { collectHooks, isHookable, runHooks, subscriptions } from '../../src/core/apphooks';
import { APPS } from '../../src/apps/registry';
import { diffLines } from '../../src/core/linediff';
import { initialState, reduce } from '../../src/core/reducer';
import { readableShared } from '../../src/core/shared';
import type { GlassState } from '../../src/core/types';

const ctx: EventContext = { ingestFile: (p) => `/stored/${p.split('/').pop()}`, readText: () => '# plan from disk' };
const fresh = () => initialState({ id: 'test', cwd: '/tmp/proj' });
// A real session recorded through the glass mod (Read, Edit, Write a plan, Bash, WebSearch, tasks,
// a background agent), as the glass received it.
const fixtures: GlassEvent[] = readFileSync(join(__dirname, '../fixtures/mod-events.ndjson'), 'utf8')
  .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const apply = (s: GlassState, ...evs: GlassEvent[]) => evs.reduce((x, ev) => applyEvent(x, ev, ctx), s);
const toolEnd = (tool: string) => fixtures.find((e) => e.e === 'tool.end' && e.tool === tool)!;

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

describe('attention: the follow* settings', () => {
  const edit = () => toolEnd('Edit');
  const withFollow = (follow: EventContext['follow'], s: GlassState, ...evs: GlassEvent[]) => evs.reduce((x, ev) => applyEvent(x, ev, { ...ctx, follow }), s);
  // Changes exists and is on screen, but not in front.
  const base = () => reduce(apply(fresh(), edit()), { type: 'window.move', id: 'changes', index: 2 }).state;

  it('off does nothing; light lights the window where it is', () => {
    expect(withFollow({ edits: 'off' }, base(), edit()).signal).toBeUndefined();
    const s = withFollow({ edits: 'light' }, base(), edit());
    expect(s.signal).toMatchObject({ kind: 'spotlight', target: 'changes' });
    expect(s.order[0]).not.toBe('changes');
  });

  it('front moves it to slot 0; both also lights it; focus also shows desktop 1', () => {
    const front = withFollow({ edits: 'front' }, base(), edit());
    expect(front.order[0]).toBe('changes');
    expect(front.signal).toBeUndefined();
    const both = withFollow({ edits: 'both' }, base(), edit());
    expect(both.order[0]).toBe('changes');
    expect(both.signal?.target).toBe('changes');
    const viewing = reduce(base(), { type: 'ui.viewDesktop', index: 2 }).state;
    expect(withFollow({ edits: 'focus' }, viewing, edit()).ui.viewingDesktop).toBe(0);
    expect(withFollow({ edits: 'both' }, viewing, edit()).ui.viewingDesktop).toBe(2); // only focus moves the view
  });

  it('a window the user closed stays closed', () => {
    const closed = reduce(base(), { type: 'window.close', id: 'changes' }).state;
    const s = withFollow({ edits: 'focus' }, closed, edit());
    expect(s.order).not.toContain('changes');
    expect(s.signal).toBeUndefined();
  });

  it('a plan file follows followPlans, not followEdits; a failed test run lights Tests red', () => {
    const plan: GlassEvent = { e: 'tool.end', tool: 'Write', id: 'w', input: { file_path: '/p/plans/x.md', content: '# Plan' }, result: {} };
    const s = withFollow({ edits: 'off', plans: 'light' }, fresh(), plan);
    expect(s.signal?.target).toBe('plan');
    const run = (stdout: string): GlassEvent => ({ e: 'tool.end', tool: 'Bash', id: `r${stdout.length}`, input: { command: 'npx vitest run' }, result: { stdout } });
    const failed = withFollow({ tests: 'light' }, reduce(fresh(), { type: 'instance.create', appType: 'tests' }).state, run('Tests  1 failed | 2 passed (3)'));
    expect(failed.signal).toMatchObject({ kind: 'alert', target: 'tests' });
    const passed = withFollow({ tests: 'light' }, reduce(fresh(), { type: 'instance.create', appType: 'tests' }).state, run('Tests  3 passed (3)'));
    expect(passed.signal).toBeUndefined();
  });

  it('the browser follows web research as it starts; agents when one starts', () => {
    const s = withFollow({ web: 'both' }, fresh(), { e: 'tool.start', tool: 'WebSearch', id: 'ws', input: { query: 'q' } });
    expect(s.signal?.target).toBe('browser');
    const a0 = reduce(reduce(fresh(), { type: 'instance.create', appType: 'agents' }).state, { type: 'window.move', id: 'agents', index: 2 }).state;
    const a = withFollow({ agents: 'front' }, a0, { e: 'tool.start', tool: 'Agent', id: 'ag', input: { description: 'd', prompt: 'p' } });
    expect(a.order[0]).toBe('agents');
  });
});

describe('the guide and the follow* settings', () => {
  it('tells Claude what the glass already does on its own, and nothing when all are off', () => {
    const g = guideFor({ defaultLayout: 'grid', followEdits: 'both', followTests: 'light' });
    expect(g).toContain("don't repeat these by hand");
    expect(g).toContain('- an edit (Changes): brought to the front and lit');
    expect(g).toContain('- a failing test run (Tests): lit');
    expect(guideFor({ defaultLayout: 'grid' })).not.toContain("don't repeat these by hand");
  });
});

describe('waiting on the user (synthetic events: not in the recorded session)', () => {
  const ask: GlassEvent = {
    e: 'tool.start', tool: 'AskUserQuestion', id: 'q1',
    input: { questions: [{ question: 'Which dock order?', header: 'Dock', options: [{ label: 'Windows', description: 'Tile order' }, { label: 'Fixed' }] }] },
  };
  it('AskUserQuestion shows a question until its call ends', () => {
    let s = apply(fresh(), ask);
    expect(s.session.waiting).toMatchObject({ kind: 'question', summary: 'Which dock order?', toolUseId: 'q1' });
    expect(s.session.waiting!.questions![0].options.map((o) => o.label)).toEqual(['Windows', 'Fixed']);
    s = apply(s, { e: 'tool.end', tool: 'Bash', id: 'other', input: {} });
    expect(s.session.waiting).toBeDefined(); // a parallel tool finishing doesn't clear it
    s = apply(s, { e: 'tool.end', tool: 'AskUserQuestion', id: 'q1', input: {} });
    expect(s.session.waiting).toBeUndefined();
  });
  it('a permission prompt shows a wait; the end of the turn or a new prompt clears it', () => {
    let s = apply(fresh(), { e: 'permission', tool: 'Bash', input: { command: 'npm run e2e' } });
    expect(s.session.waiting).toMatchObject({ kind: 'permission', summary: '$ npm run e2e', tool: 'Bash' });
    s = apply(s, { e: 'turn.complete', turnId: 't' });
    expect(s.session.waiting).toBeUndefined();
    s = apply(s, { e: 'permission', tool: 'Bash', input: { command: 'ls' } }, { e: 'turn.start', turnId: 't2', text: 'hi' });
    expect(s.session.waiting).toBeUndefined();
  });
});

describe('events (a real recorded session)', () => {
  const run = () => apply(fresh(), ...fixtures);

  it('builds the conversation from the prompt and the streamed reply', () => {
    const conv = run().appState.conversation as ConversationState;
    expect(conv.messages[0]).toMatchObject({ role: 'user', done: true });
    expect(messageText(conv.messages[0])).toMatch(/^Do these steps in order/);
    const replies = conv.messages.filter((m) => m.role === 'assistant').map(messageText);
    expect(replies).toHaveLength(10);
    expect(replies[3]).toBe("**Step 4: Edit notes.txt to change 'hello' to 'goodbye'**");
    expect(replies[9]).toMatch(/^All steps completed successfully/);
    expect(conv.messages.every((m) => m.done)).toBe(true);
  });

  it('streams: the latest text of a block replaces the earlier one', () => {
    const s = apply(fresh(), { e: 'text', id: 't:0:1', text: 'hel' }, { e: 'text', id: 't:0:1', text: 'hello' }, { e: 'text', id: 't:0:1', text: 'hello world', final: true });
    const conv = s.appState.conversation as ConversationState;
    expect(conv.messages).toHaveLength(1);
    expect(conv.messages[0]).toMatchObject({ done: true });
    expect(messageText(conv.messages[0])).toBe('hello world');
  });

  it('records every tool call in the terminal', () => {
    const all = (run().appState.terminal as TerminalState).entries;
    // The turn starts with a divider carrying the prompt; every call after it belongs to that turn.
    expect(all[0]).toMatchObject({ kind: 'turn', turnId: '862ffe70-418c-445f-b880-177f5d6e2cb2' });
    expect(all[0].summary).toMatch(/^Do these steps in order/);
    expect(all.slice(1).every((e) => e.turnId === all[0].turnId)).toBe(true);
    const term = { entries: all.slice(1) };
    expect(term.entries.map((e) => e.tool)).toEqual(['ToolSearch', 'TaskCreate', 'TaskCreate', 'TaskCreate', 'Read', 'Read', 'Edit', 'Write', 'Bash', 'Bash', 'WebSearch', 'Agent', 'TaskUpdate', 'TaskUpdate', 'TaskUpdate']);
    expect(term.entries.every((e) => e.status === 'ok')).toBe(true);
    const cat = term.entries.find((e) => e.summary === '$ cat notes.txt')!;
    expect(cat.output).toBe('goodbye world\nsecond line');
  });

  it('the session goes working → idle → ended', () => {
    expect(apply(fresh(), ...fixtures.slice(0, 3)).session.activity).toBe('working');
    const s = run();
    expect(s.session.activity).toBe('idle');
    expect(s.session.endedAt).toBeGreaterThan(0);
    expect(s.session.cwd).toBe('/private/tmp/proj');
  });

  it('auto-opens the changes diff viewer once', () => {
    const s = run();
    expect(s.order).toContain('changes');
    const d = s.appState.changes as DiffState;
    const notes = '/private/tmp/proj/notes.txt';
    expect(d.files).toEqual(['/private/tmp/proj/plans/p.md', notes]); // newest first
    expect(d.revisions[notes][0].hunks[0].lines).toEqual(['-hello world', '+goodbye world', ' second line']);
    // user closes it; further edits don't reopen it
    let s2 = reduce(s, { type: 'window.close', id: 'changes' }).state;
    s2 = apply(s2, toolEnd('Edit'));
    expect(s2.order).not.toContain('changes');
    expect((s2.appState.changes as DiffState).revisions[notes]).toHaveLength(2);
  });

  it('shows plans, images, tasks, agents and files automatically', () => {
    const s = run();
    expect((s.appState.plan as any).content).toMatch(/^# Plan/);
    expect((s.appState.images as any).images[0].file).toBe('/stored/icon.png');
    expect((s.appState.tasks as any).items.map((t: any) => [t.subject, t.status])).toEqual([
      ['Read files', 'completed'], ['Edit and write files', 'completed'], ['Search and agent task', 'completed'],
    ]);
    // A background agent: launched by the Agent call, finished by its own turn's end.
    expect((s.appState.agents as any).runs[0]).toMatchObject({ description: 'Simple agent response task', agentId: 'a1fe987c11ea142db', background: true, status: 'done', result: 'done' });
    expect(Object.keys((s.appState.files as any).files)).toEqual(['notes.txt', 'icon.png', 'plans/p.md']);
  });

  it('a failed tool call is an error, with no side effects', () => {
    const s = apply(fresh(), { e: 'tool.end', tool: 'Write', id: 'w', input: { file_path: '/p/x.md', content: 'x' }, error: 'File has not been read yet.' });
    const t = s.appState.terminal as TerminalState;
    expect(t.entries[0].status).toBe('error');
    expect(s.instances.changes).toBeUndefined();
  });

  it('start/end arriving out of order still yields one entry', () => {
    let s = fresh();
    s = apply(s, { e: 'tool.end', tool: 'Bash', id: 'x', input: { command: 'ls' }, result: { stdout: 'a' } });
    s = apply(s, { e: 'tool.start', tool: 'Bash', id: 'x', input: { command: 'ls' } });
    const t = s.appState.terminal as TerminalState;
    expect(t.entries).toHaveLength(1);
    // a late start must not flip a finished entry back to running
    expect(t.entries[0].status).toBe('ok');
  });

  it('Changes knows which files the latest turn changed', () => {
    const editIn = (turnId: string, path: string): GlassEvent[] => [
      { e: 'turn.start', turnId, text: `turn ${turnId}` },
      { e: 'tool.end', tool: 'Edit', id: `${turnId}-${path}`, input: { file_path: path, old_string: 'a', new_string: 'b' }, result: {} },
      { e: 'turn.complete', turnId },
    ];
    const s = apply(fresh(), ...editIn('t1', '/p/a.ts'), ...editIn('t2', '/p/b.ts'));
    const d = s.appState.changes as DiffState;
    expect(d.turn).toBe('t2');
    expect(d.revisions['/p/a.ts'][0].turnId).toBe('t1');
    expect(d.files.filter((f) => d.revisions[f].some((r) => r.turnId === d.turn))).toEqual(['/p/b.ts']);
    expect(reduce(s, { type: 'app.command', id: 'changes', command: 'scope', args: { scope: 'turn' } }).state.appState.changes).toMatchObject({ scope: 'turn' });
  });

  it('tracks the turn: started, each model request a step, gone when it ends', () => {
    let s = apply(fresh(), { e: 'turn.start', turnId: 't1', text: 'go' });
    expect(s.session.turn).toMatchObject({ id: 't1', steps: 0 });
    s = apply(s, { e: 'step', turnId: 't1', index: 0 }, { e: 'step', turnId: 't1', index: 1 });
    expect(s.session.turn).toMatchObject({ id: 't1', steps: 2 });
    s = apply(s, { e: 'turn.complete', turnId: 't1' });
    expect(s.session.turn).toBeUndefined();
  });

  it('records how a turn ended, and the usage Claude Code measured', () => {
    let s = apply(fresh(), { e: 'turn.start', turnId: 't1', text: 'go' }, { e: 'turn.complete', turnId: 't1', durationMs: 42000, reason: 'answer' });
    expect(s.session.lastTurn).toMatchObject({ id: 't1', durationMs: 42000, reason: 'answer' });
    s = apply(s, { e: 'usage', context: { tokens: 50000, window: 200000, percent: 25 }, cost: { usd: 0.42 }, rateLimits: [{ kind: 'five_hour', percentUsed: 16, resetsAt: 'x' }] });
    expect(s.session.usage).toMatchObject({ context: { tokens: 50000, window: 200000, percent: 25 }, cost: { usd: 0.42 }, rateLimits: [{ kind: 'five_hour', percentUsed: 16 }] });
    s = apply(s, { e: 'usage', cost: { usd: 0.5 } }); // a partial measure keeps the rest
    expect(s.session.usage).toMatchObject({ context: { percent: 25 }, cost: { usd: 0.5 } });
  });

  it('ignores what it does not know', () => {
    const s = fresh();
    expect(apply(s, { e: 'nope' } as any, null as any, { foo: 1 } as any)).toEqual(s);
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
    const web = fixtures.filter((e) => 'tool' in e && e.tool === 'WebSearch');
    let s = fresh();
    s = apply(s, web[0]); // the search starts
    const b = () => s.appState.browser as BrowserState;
    expect(s.order[0]).toBe('browser'); // auto-opened
    expect(currentWeb(b())).toMatchObject({ kind: 'search', query: 'Claude glass mirror', results: null });
    s = apply(s, web[1]); // its results
    expect(b().history).toHaveLength(1); // results fill in the pending search, no new entry
    expect((currentWeb(b()) as any).results[0]).toEqual({ title: 'Claude glass', url: 'https://en.wikipedia.org/wiki/Claude_glass' });
    s = apply(s, { e: 'tool.start', tool: 'WebFetch', id: 'f1', input: { url: 'https://chromedevtools.github.io/devtools-protocol/tot/Page/', prompt: 'x' } });
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

describe('app sets: which apps are on in this glass', () => {
  it('a glass\'s own setting wins over the global one, either way', () => {
    expect(isAppOff('tasks', { disabledApps: [] }, undefined)).toBe(false);
    expect(isAppOff('tasks', { disabledApps: ['tasks'] }, undefined)).toBe(true);
    expect(isAppOff('tasks', { disabledApps: ['tasks'] }, { apps: { tasks: true } })).toBe(false);
    expect(isAppOff('tasks', { disabledApps: [] }, { apps: { tasks: false } })).toBe(true);
    expect(isAppOff('settings', { disabledApps: [] }, { apps: { settings: false } })).toBe(false);
  });
  it('settings.set apps.<type>: on, off, back to default; anything else is refused', () => {
    let s = reduce(fresh(), { type: 'settings.set', key: 'apps.tasks', value: false }).state;
    s = reduce(s, { type: 'settings.set', key: 'apps.files', value: true }).state;
    expect(s.settings.apps).toEqual({ tasks: false, files: true });
    s = reduce(s, { type: 'settings.set', key: 'apps.tasks', value: 'default' }).state;
    s = reduce(s, { type: 'settings.set', key: 'apps.files', value: undefined }).state;
    expect(s.settings.apps).toBeUndefined();
    expect(() => reduce(s, { type: 'settings.set', key: 'apps.tasks', value: 'maybe' })).toThrow(/true, false or default/);
    expect(() => reduce(s, { type: 'settings.set', key: 'apps', value: {} })).toThrow(/usage/);
    expect(() => reduce(s, { type: 'settings.set', key: 'buildApps', value: 'yes' })).toThrow(/true or false/);
  });
  it('the guide: apps that are on bring their instructions, off ones only a catalog line', () => {
    attachBuiltinViews(join(__dirname, '../../dist/apps')); // built-ins read their guide.md from the build
    const on = guideFor({ defaultLayout: 'grid' });
    expect(on).toContain('## Tasks (`tasks`)');
    expect(on).not.toContain('Off in this glass');
    const off = guideFor({ defaultLayout: 'grid' }, { apps: { tasks: false } });
    expect(off).not.toContain('## Tasks (`tasks`)');
    expect(off).toMatch(/Off in this glass[^\n]*\n- Tasks \(`tasks`\): /);
    expect(off.length).toBeLessThan(on.length);
    // turned off everywhere but on here
    expect(guideFor({ defaultLayout: 'grid', disabledApps: ['tasks'] }, { apps: { tasks: true } })).toContain('## Tasks (`tasks`)');
  });
  it('the workspace nudge only when buildApps is on', () => {
    expect(guideFor({ defaultLayout: 'grid' })).not.toContain('apps new <type> --project');
    expect(guideFor({ defaultLayout: 'grid' }, { buildApps: true })).toContain('apps new <type> --project');
  });
  it('presets carry the app set, and applying one replaces the glass\'s', () => {
    let s = reduce(fresh(), { type: 'settings.set', key: 'apps.tasks', value: false }).state;
    const p = capturePreset(s, DEFAULT_CONFIG, 'quiet', '');
    expect(p.session?.apps).toEqual({ tasks: false });
    s = reduce(fresh(), { type: 'settings.set', key: 'apps.files', value: false }).state;
    for (const a of presetActions(s, p, () => true).actions) s = reduce(s, a).state;
    expect(s.settings.apps).toEqual({ tasks: false });
    // a preset saved before app sets leaves the glass's alone
    for (const a of presetActions(s, { name: 'old', description: '', session: { windowMode: 'live' } }, () => true).actions) s = reduce(s, a).state;
    expect(s.settings.apps).toEqual({ tasks: false });
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

describe('custom apps', () => {
  let reports: ReturnType<typeof loadApps> = [];
  beforeAll(() => { reports = loadApps(join(__dirname, '../fixtures/apps')); });
  afterAll(() => { for (const r of reports) if (r.ok) delete APPS[r.type]; });
  it('two-way hooks: register(on) like a mod; deny, pass on (changed), or ask the user', async () => {
    const { hooks, errors } = collectHooks();
    expect(errors).toEqual({});
    expect(subscriptions(hooks)).toEqual({ 'tool.call': ['Bash'], 'prompt.submit': ['*'] });
    let asked = '';
    const writes: unknown[] = [];
    const glassFor = (app: any) => ({ app: app.type, stored: { refused: 2 }, store: (p: unknown) => writes.push(p), ask: async (q: string) => { asked = q; return 'No'; } });
    expect(await runHooks(hooks, 'tool.call', { tool: 'Bash', input: { command: 'rm -rf /' } }, glassFor)).toEqual({ answer: { deny: 'Guard: not deleting the root folder.' } });
    expect(writes).toEqual([{ refused: 3 }]);
    expect(await runHooks(hooks, 'tool.call', { tool: 'Bash', input: { command: 'npm run deploy' } }, glassFor)).toEqual({ answer: { deny: 'Guard: the user said "No".' } });
    expect(asked).toBe('Run "npm run deploy"?');
    expect(await runHooks(hooks, 'tool.call', { tool: 'Bash', input: { command: 'ls' } }, glassFor)).toEqual({ e: { tool: 'Bash', input: { command: 'ls' } } });
    expect(await runHooks(hooks, 'tool.call', { tool: 'Read', input: {} }, glassFor)).toEqual({ e: { tool: 'Read', input: {} } }); // not matched
    expect(await runHooks(hooks, 'prompt.submit', { text: 'hi', context: ['x'] }, glassFor)).toEqual({ e: { text: 'hi', context: ['x', 'Guard is watching this session.'] } });
  });
  it('apps hook any Claude Code event by name, except streams, drawing and the mod\'s transport', async () => {
    expect(isHookable('attribution.text')).toBe(true);
    expect(isHookable('classic.Stop')).toBe(true);
    expect(isHookable('some.futureEvent')).toBe(true); // a name Claude Code adds later
    for (const e of ['turn.step', 'ui.render', 'process.run', 'engine.create', 'telemetry.log', 'nope']) expect(isHookable(e)).toBe(false);
    const hooks = [{ app: 'guard', event: 'attribution.text', matcher: {}, fn: async (_g: unknown, e: any) => ({ text: `${e.text}!` }) }];
    expect(subscriptions(hooks)).toEqual({ 'attribution.text': ['*'] });
    expect(await runHooks(hooks, 'attribution.text', { text: 'hi' }, () => ({}) as any)).toEqual({ answer: { text: 'hi!' } });
  });
  it('register(on) needs the twoWay permission', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cg-oneway-'));
    writeFileSync(join(dir, 'glass-app.json'), JSON.stringify({ apiVersion: 1, type: 'sneaky', title: 'Sneaky', commands: {} }));
    writeFileSync(join(dir, 'core.js'), 'exports.init = () => ({}); exports.command = (s) => s; exports.register = () => {};');
    expect(() => readApp(dir)).toThrow(/twoWay/);
  });
  it('loads good mods and reports broken ones without throwing', () => {
    expect(reports.find((r) => r.type === 'tool-count')).toMatchObject({ ok: true });
    expect(reports.find((r) => r.type === 'broken')).toMatchObject({ ok: false, error: expect.stringContaining('command()') });
    expect(APPS['tool-count']).toMatchObject({ source: 'user', singleton: true, icon: '#' });
  });
  it('onEvent creates, auto-opens and fills a singleton from session events', () => {
    const s = apply(fresh(), ...fixtures);
    expect(s.order).toContain('tool-count');
    expect((s.appState['tool-count'] as any).counts).toMatchObject({ Read: 2, Edit: 1, Bash: 2, TaskCreate: 3 });
  });
  it('stored values: cores read ctx.stored and write with ctx.store; only declared keys, JSON, within limits', () => {
    let s = reduce(fresh(), { type: 'instance.create', appType: 'tool-count' }).state;
    s = reduce(s, { type: 'app.command', id: 'tool-count', command: 'pin', args: { tool: 'Bash' } }).state;
    s = reduce(s, { type: 'app.command', id: 'tool-count', command: 'pin', args: { tool: 'Read' } }).state;
    expect(s.stored?.['tool-count']).toEqual({ pinned: ['Bash', 'Read'] });
    s = apply(s, { e: 'tool.start', tool: 'Bash', id: 'b1', input: {} }, { e: 'tool.start', tool: 'Bash', id: 'b2', input: {} });
    expect(s.stored?.['tool-count']).toMatchObject({ total: 2 });
    expect((s.appState['tool-count'] as any).counts.Bash).toBe(2); // the state still changed too
    expect(() => reduce(s, { type: 'stored.set', app: 'tool-count', values: { nope: 1 } })).toThrow(/isn't a stored value/);
    expect(() => reduce(s, { type: 'stored.set', app: 'tool-count', values: { pinned: 'x'.repeat(300 * 1024) } })).toThrow(/over 256 KB/);
    s = reduce(s, { type: 'stored.reset', app: 'tool-count', keys: ['total'] }).state;
    expect(s.stored?.['tool-count']).toEqual({ pinned: ['Bash', 'Read'] });
    s = reduce(s, { type: 'stored.load', app: 'tool-count', values: { pinned: undefined, total: 7 } }).state; // another glass's file
    expect(s.stored?.['tool-count']).toEqual({ total: 7 });
    s = reduce(s, { type: 'stored.reset', app: 'tool-count' }).state;
    expect(s.stored?.['tool-count']).toBeUndefined();
  });
  it('public state: share() picks what other apps see; only apps whose permissions.reads lists the type read it', () => {
    let s = apply(fresh(), { e: 'tool.start', tool: 'Bash', id: 'b1', input: {} });
    s = reduce(s, { type: 'app.command', id: 'tool-count', command: 'note', args: { text: 'private' } }).state;
    expect(s.shared?.['tool-count']).toEqual({ counts: { Bash: 1 } }); // the note isn't shared
    expect(APPS.guard.permissions?.reads).toEqual(['tool-count']);
    expect(readableShared(s, APPS.guard.permissions!.reads)).toEqual([{ id: 'tool-count', type: 'tool-count', title: 'Tool count', data: { counts: { Bash: 1 } } }]);
    expect(readableShared(s, [])).toEqual([]); // no permission, nothing
    expect(readableShared(s, ['diff'])).toEqual([]);
    s = reduce(s, { type: 'instance.delete', id: 'tool-count' }).state;
    expect(s.shared?.['tool-count']).toBeUndefined();
    expect(() => parsePermissions({ reads: ['Not A Type'] })).toThrow(/not an app type/);
  });
  it('built-ins share basics, cached only when some app reads them', () => {
    const s = apply(fresh(), ...fixtures);
    expect(s.shared?.terminal).toBeUndefined(); // nobody reads terminal: never computed
    expect(s.shared?.changes).toBeUndefined();
    const term = APPS.terminal.share!(s.appState.terminal) as any;
    expect(term.recent.length).toBeGreaterThan(0);
    expect(term.recent[0]).toEqual({ tool: expect.any(String), summary: expect.any(String), status: expect.any(String), at: expect.any(Number), ...(term.recent[0].durationMs != null ? { durationMs: expect.any(Number) } : {}) });
    expect(JSON.stringify(term)).not.toContain('"output"'); // one line each, no output
    const diff = APPS.diff.share!(s.appState.changes) as any;
    expect(diff.files[0]).toMatchObject({ path: expect.any(String), changes: expect.any(Number), thisTurn: expect.any(Boolean) });
    expect((APPS.tasks.share!(s.appState.tasks) as any).items[0]).toMatchObject({ subject: expect.any(String), status: expect.any(String) });
  });
  it('a stored write from an event does not create a window that has nothing to show', () => {
    // tool-count is a singleton that auto-creates on its first change; here only the count changes.
    const s = apply(fresh(), { e: 'tool.start', tool: 'Read', id: 'r', input: {} });
    expect(s.instances['tool-count']).toBeTruthy();
    expect(s.stored?.['tool-count']).toMatchObject({ total: 1 });
  });
  it('mod commands run through the reducer; guide lands in Claude’s instructions', () => {
    let s = reduce(fresh(), { type: 'instance.create', appType: 'tool-count' }).state;
    s = reduce(s, { type: 'app.command', id: 'tool-count', command: 'note', args: { text: 'hi' } }).state;
    expect((s.appState['tool-count'] as any).note).toBe('hi');
    expect(guideFor({ defaultLayout: 'grid' })).toContain('## Tool count (`tool-count`)');
  });
});

describe('disabled apps', () => {
  it('events leave turned-off apps untouched (no auto-created windows, no state changes)', () => {
    const ctxOff: EventContext = { ...ctx, disabled: new Set(['diff', 'terminal']) };
    let s = fresh();
    const term = s.appState.terminal;
    for (const ev of fixtures) s = applyEvent(s, ev, ctxOff);
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
  const hctx: EventContext = { ...ctx, windowMode: 'history' };
  const editAs = (id: string) => ({ ...toolEnd('Edit'), id }) as GlassEvent;
  it('every action gets its own window, newest at slot 0', () => {
    let s = applyEvent(applyEvent(fresh(), editAs('toolu_A1'), hctx), editAs('toolu_B2'), hctx);
    expect(s.order.slice(0, 2)).toEqual(['changes-tooluB2', 'changes-tooluA1']);
    expect(s.instances['changes-tooluB2'].title).toBe('Changes');
  });
  it("a search's start and results share one browser window", () => {
    const web = fixtures.filter((e) => 'tool' in e && e.tool === 'WebSearch');
    let s = fresh();
    for (const ev of web) s = applyEvent(s, ev, hctx);
    const browsers = Object.values(s.instances).filter((i) => i.type === 'browser');
    expect(browsers).toHaveLength(1);
    expect((s.appState[browsers[0].id] as BrowserState).history[0]).toMatchObject({ kind: 'search', results: expect.any(Array) });
  });
  it('keeps only the newest historyLimit windows; pinned ones survive', () => {
    let s = reduce(fresh(), { type: 'settings.set', key: 'historyLimit', value: 3 }).state;
    s = applyEvent(s, editAs('toolu_P0'), hctx);
    s = reduce(s, { type: 'window.tuck', id: 'changes-tooluP0', edge: 'left' }).state;
    for (let i = 1; i <= 5; i++) s = applyEvent(s, editAs(`toolu_E${i}`), hctx);
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
    expect(parsePermissions(undefined)).toEqual({ network: [], microphone: false, storage: false, sharedSignIn: false, twoWay: false, reads: [] });
    expect(parsePermissions({ network: ['http://127.0.0.1:3100/api', 'ws://127.0.0.1:3100'], microphone: true, storage: true }))
      .toEqual({ network: ['http://127.0.0.1:3100', 'ws://127.0.0.1:3100'], microphone: true, storage: true, sharedSignIn: false, twoWay: false, reads: [] });
    // Answering back into the session is its own, explicit permission.
    expect(parsePermissions({ twoWay: true }).twoWay).toBe(true);
    expect(parsePermissions({ twoWay: 'yes' }).twoWay).toBe(false);
    // Shared sign-in is opt-in, and means nothing without origins to share.
    expect(parsePermissions({ network: ['http://localhost:3100'], sharedSignIn: true }).sharedSignIn).toBe(true);
    expect(parsePermissions({ sharedSignIn: true }).sharedSignIn).toBe(false);
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
  it('switching presets closes what the new one doesn\'t name and opens its windows in tile order', () => {
    let a = reduce(fresh(), { type: 'window.tuck', id: 'terminal', edge: 'left' }).state;
    a = reduce(a, { type: 'instance.create', appType: 'markdown', id: 'notes' }).state;
    a = reduce(a, { type: 'instance.create', appType: 'diagram', id: 'flow' }).state;
    a = reduce(a, { type: 'window.close', id: 'conversation' }).state;
    const p = capturePreset(a, DEFAULT_CONFIG, 'docs');
    expect(p.windows?.map((w) => w.id)).toEqual(a.order);
    // Another glass: conversation in the layout, the terminal docked at the bottom, a free window.
    let b = reduce(fresh(), { type: 'window.tuck', id: 'terminal', edge: 'bottom' }).state;
    b = reduce(b, { type: 'instance.create', appType: 'html', id: 'page' }).state;
    b = reduce(b, { type: 'window.free', id: 'page' }).state;
    for (const act of presetActions(b, p, () => true).actions) b = reduce(b, act).state;
    expect(b.order).toEqual(a.order); // the preset's windows, in its order (created where missing)
    expect(b.tucked?.left).toEqual(['terminal']);
    expect(b.tucked?.bottom ?? []).toEqual([]);
    expect(b.free?.page).toBeUndefined(); // closed, not just moved
    expect(b.order).not.toContain('conversation');
    // A preset saved before presets named their windows leaves the layout's windows alone.
    let c = reduce(fresh(), { type: 'instance.create', appType: 'markdown', id: 'notes' }).state;
    const before = c.order;
    for (const act of presetActions(c, { name: 'old', description: '', sidebars: {} }, () => true).actions) c = reduce(c, act).state;
    expect(c.order).toEqual(before);
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
    const ver = (v: string) => { const root = join(dir, 'cache', 'n33kos', 'glass', v); mkdirSync(join(root, 'bin'), { recursive: true }); writeFileSync(join(root, 'bin', 'claude-glass'), ''); return root; };
    const old = ver('1.4.0'), now = ver('1.4.1');
    writeFileSync(join(dir, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'glass@n33kos': [{ scope: 'user', installPath: now, version: '1.4.1' }] } }));
    expect(pendingUpdate(old, dir)).toEqual({ version: '1.4.1', root: now });
    expect(pendingUpdate(now, dir)).toBeNull();
    expect(pendingUpdate('/Users/someone/claude-glass', dir)).toBeNull(); // a dev checkout
    expect(installedGlass(join(dir, 'nowhere'))).toBeNull();
    writeFileSync(join(old, 'package.json'), JSON.stringify({ version: '1.4.0' }));
    expect(ownVersion(old, dir)).toEqual({ version: '1.4.0', dev: false });
    expect(ownVersion(join(__dirname, '../..'), dir)).toMatchObject({ dev: true });
  });
  it("an older version's launcher runs the installed version's CLI; the installed one runs its own", () => {
    const config = mkdtempSync(join(tmpdir(), 'cg-config-'));
    const launcher = readFileSync(join(__dirname, '../../bin/claude-glass'), 'utf8');
    const ver = (v: string) => {
      const root = join(config, 'plugins', 'cache', 'n33kos', 'glass', v);
      mkdirSync(join(root, 'bin'), { recursive: true });
      mkdirSync(join(root, 'dist'), { recursive: true });
      writeFileSync(join(root, 'bin', 'claude-glass'), launcher);
      writeFileSync(join(root, 'dist', 'cli.js'), `console.log('${v}', process.argv.slice(2).join(' '))`);
      return root;
    };
    const old = ver('1.3.1'), now = ver('2.0.0');
    writeFileSync(join(config, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'glass@n33kos': [{ scope: 'user', installPath: now, version: '2.0.0' }] } }));
    const run = (root: string) => execFileSync(process.execPath, [join(root, 'bin', 'claude-glass'), 'open', '--x'], { env: { ...process.env, CLAUDE_CONFIG_DIR: config, CLAUDE_GLASS_FORWARDED: '' }, encoding: 'utf8' }).trim();
    expect(run(old)).toBe('2.0.0 open --x');
    expect(run(now)).toBe('2.0.0 open --x');
    // A record pointing back at the old folder still ends in one CLI, not a loop.
    writeFileSync(join(config, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'glass@n33kos': { installPath: old, version: '1.3.1' } } }));
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
  it('an overlay app\'s window opens over the whole glass, out of the layout and the docks', () => {
    APPS['ov-test'] = { type: 'ov-test', title: 'Overlay', icon: '◎', singleton: true, description: '', commands: {}, init: () => ({}), command: (s: any) => s, display: 'overlay' };
    try {
      let s = reduce(fresh(), { type: 'instance.create', appType: 'ov-test' }).state;
      expect(s.order).not.toContain('ov-test');
      expect(s.overlays).toEqual(['ov-test']);
      expect(() => reduce(s, { type: 'window.tuck', id: 'ov-test', edge: 'right' })).toThrow(/overlay/);
      s = reduce(s, { type: 'window.close', id: 'ov-test' }).state;
      expect(s.overlays).toEqual([]);
      s = reduce(s, { type: 'window.open', id: 'ov-test' }).state;
      expect([s.order.includes('ov-test'), s.overlays]).toEqual([false, ['ov-test']]);
      s = reduce(s, { type: 'instance.delete', id: 'ov-test' }).state;
      expect(s.overlays).toEqual([]);
    } finally { delete APPS['ov-test']; }
  });
  it('free windows sit wherever they\'re put, over the layout; one window can fill the background', () => {
    let s = reduce(fresh(), { type: 'window.tuck', id: 'terminal', edge: 'bottom' }).state;
    s = reduce(s, { type: 'window.free', id: 'terminal' }).state; // out of its dock
    expect(s.tucked?.bottom ?? []).toEqual([]);
    expect(s.free?.terminal).toEqual({ x: 0.25, y: 0.15, w: 0.5, h: 0.6 });
    s = reduce(s, { type: 'window.free', id: 'conversation', rect: { x: 0.6, y: 0.1, w: 0.3, h: 0.4 } }).state;
    expect(s.order).not.toContain('conversation');
    expect(s.freeOrder).toEqual(['terminal', 'conversation']);
    s = reduce(s, { type: 'window.place', id: 'terminal', rect: { x: 2, y: -1, w: 0.01, h: 3 } }).state; // kept on the glass, raised
    expect(s.free?.terminal).toEqual({ x: 0.95, y: 0, w: 0.08, h: 1 });
    expect(s.freeOrder).toEqual(['conversation', 'terminal']);
    s = reduce(s, { type: 'window.move', id: 'conversation', index: 0 }).state; // bringing it forward raises it
    expect([s.freeOrder, s.order.includes('conversation')]).toEqual([['terminal', 'conversation'], false]);
    s = reduce(s, { type: 'window.open', id: 'conversation' }).state;
    expect(s.order).not.toContain('conversation');
    s = reduce(s, { type: 'instance.create', appType: 'markdown', id: 'notes' }).state;
    expect(() => reduce(s, { type: 'window.place', id: 'notes', rect: { x: 0, y: 0, w: 1, h: 1 } })).toThrow(/isn't a free window/);
    // The background: out of the free windows; a new one sends the old one back into the layout.
    s = reduce(s, { type: 'window.backdrop', id: 'conversation' }).state;
    expect([s.backdrop, s.free?.conversation, s.order.includes('conversation')]).toEqual(['conversation', undefined, false]);
    s = reduce(s, { type: 'window.backdrop', id: 'terminal' }).state;
    expect([s.backdrop, s.order.includes('conversation')]).toEqual(['terminal', true]);
    s = reduce(s, { type: 'window.backdrop', id: null }).state;
    expect([s.backdrop, s.order[0]]).toEqual([undefined, 'terminal']);
    s = reduce(s, { type: 'window.free', id: 'terminal' }).state;
    s = reduce(s, { type: 'window.untuck', id: 'terminal' }).state; // back into the layout
    expect([s.free?.terminal, s.order[0]]).toEqual([undefined, 'terminal']);
  });
  it('a dock floats over the layout: kept open, until released or emptied', () => {
    let s = reduce(fresh(), { type: 'window.tuck', id: 'terminal', edge: 'bottom' }).state;
    expect(() => reduce(s, { type: 'tuck.float', edge: 'left', float: true })).toThrow(/nothing is docked/);
    s = reduce(s, { type: 'tuck.float', edge: 'bottom', float: true }).state;
    expect(s.tuckKeep).toEqual(['bottom']); // floating keeps it open
    expect(s.tuckFloat).toEqual(['bottom']);
    s = reduce(s, { type: 'tuck.float', edge: 'bottom', float: false }).state;
    expect([s.tuckKeep, s.tuckFloat]).toEqual([['bottom'], []]); // beside the layout again
    s = reduce(s, { type: 'tuck.float', edge: 'bottom', float: true }).state;
    expect(reduce(s, { type: 'tuck.keep', edge: 'bottom', keep: false }).state.tuckFloat).toEqual([]); // released
    expect(reduce(s, { type: 'window.untuck', id: 'terminal' }).state.tuckFloat).toEqual([]); // emptied
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
