// Core server in plain Node, driven by the real built CLI and the bash hook forwarder.
// Requires `npm run build` first (dist/cli.js).
import { spawn } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bindSession, cleanupRuntime, folderGlassId } from '../../src/core/binding';
import { readApp } from '../../src/core/customApps';
import { GlassCore } from '../../src/core/server';

const root = join(__dirname, '../..');
const home = mkdtempSync(join(tmpdir(), 'cc-home-'));
const runtime = mkdtempSync('/tmp/cc-rt-');
process.env.CLAUDE_GLASS_HOME = home;
process.env.CLAUDE_GLASS_RUNTIME = runtime;
const SID = 'itest-session';
delete process.env.CLAUDE_PROJECT_DIR;
const env = { ...process.env, CLAUDE_GLASS_HOME: home, CLAUDE_GLASS_RUNTIME: runtime, CLAUDE_CODE_SESSION_ID: SID };

// Async on purpose: the server lives in this process, a sync exec would deadlock it.
function run(cmd: string, args: string[], input?: string, extraEnv: Record<string, string> = {}): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((res) => {
    const p = spawn(cmd, args, { env: { ...env, ...extraEnv } });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (status) => res({ status: status ?? -1, stdout: stdout.trim(), stderr }));
    p.stdin.end(input ?? '');
  });
}
async function cli(...args: string[]): Promise<string> {
  const r = await run(join(root, 'bin/claude-glass'), args);
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout;
}
/** What the glass mod does: hand a session's events to the glass through the CLI. */
async function event(session: string, ...events: object[]) {
  const r = await run(join(root, 'bin/claude-glass'), ['event', '--session', session], events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  expect(r.status).toBe(0);
}
async function sessionStart(session: string, source: string, cwd: string) {
  const r = await run(join(root, 'bin/claude-glass'), ['session-start', '--session', session, '--source', source, '--cwd', cwd]);
  expect(r.status).toBe(0);
  return JSON.parse(r.stdout);
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let core: GlassCore;
beforeAll(async () => {
  if (!existsSync(join(root, 'dist/cli.js'))) throw new Error('run npm run build first');
  core = new GlassCore(SID, '/tmp/proj');
  await core.listen();
});
afterAll(async () => { await core.close(); });

describe('CLI ↔ core over the socket', () => {
  it('view shows default windows', async () => {
    const out = await cli('view');
    expect(out).toContain('Desktop 1 [main-left]');
    expect(out).toMatch(/0\s+conversation/);
    expect(out).toMatch(/1\s+terminal/);
  });

  it('new + app command + show', async () => {
    expect(await cli('new', 'markdown', '--title', 'Notes')).toBe('markdown-1');
    await cli('app', 'markdown-1', 'set', '--text', '# Hello');
    expect((core.state.appState['markdown-1'] as any).content).toBe('# Hello');
    const f = join(home, 'x.html');
    writeFileSync(f, '<h1>hi</h1>');
    expect(await cli('show', f)).toBe('html-1 (html)');
    expect((core.state.appState['html-1'] as any).html).toBe('<h1>hi</h1>');
    expect(core.state.order[0]).toBe('html-1');
  });

  it('window move / close / open / layout', async () => {
    await cli('window', 'move', 'terminal', '0');
    expect(core.state.order[0]).toBe('terminal');
    await cli('window', 'close', 'terminal');
    expect(core.state.order).not.toContain('terminal');
    await cli('window', 'open', 'terminal');
    expect(core.state.order[0]).toBe('terminal');
    await cli('layout', '1', 'grid');
    expect(core.state.desktops[0]).toBe('grid');
    expect(await cli('view')).toContain('Desktop 1 [grid]');
  });

  it('reports errors clearly with non-zero exit', async () => {
    const r = await run(join(root, 'bin/claude-glass'), ['window', 'open', 'nope']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no such window');
  });

  it('image show copies the file into the session', async () => {
    const png = join(home, 'dot.png');
    writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
    // Every image goes to the one Images window.
    expect(await cli('show', png)).toBe('images (image)');
    expect(await cli('show', png)).toBe('images (image)');
    const st = core.state.appState['images'] as any;
    expect(st.images).toHaveLength(2);
    expect(st.images[0].file.startsWith(join(home, 'sessions', SID, 'files'))).toBe(true);
    expect(existsSync(st.images[0].file)).toBe(true);
  });

  it('status lists this glass as open', async () => {
    expect(await cli('status')).toMatch(/● open\s+itest-session/);
  });

  it('catalog hides internal commands', async () => {
    const c = JSON.parse(await cli('catalog', '--json'));
    const term = c.find((a: any) => a.type === 'terminal');
    expect(Object.keys(term.commands)).toEqual(['log', 'clear']);
  });
});

describe('the mod\'s CLI commands', () => {
  it('event hands a recorded session to the glass, in one batch', async () => {
    const events = readFileSync(join(root, 'test/fixtures/mod-events.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    await event(SID, ...events);
    const term = core.state.appState.terminal as any;
    expect(term.entries.map((e: any) => e.tool)).toContain('WebSearch');
    expect((core.state.appState.conversation as any).messages.length).toBe(11);
    expect(core.state.appState.changes).toBeTruthy();
  });

  it('event is a fast no-op when no glass exists for the session', async () => {
    const t = Date.now();
    await event('no-such-session', { e: 'tool.start', tool: 'Bash', id: 'x', input: {} });
    expect(Date.now() - t).toBeLessThan(1000);
  });

  it('session-start gives the mod the guide only when the glass is live', async () => {
    const live = await sessionStart(SID, 'compact', '/tmp/proj');
    expect(live).toMatchObject({ open: true, toolReminders: true, socket: join(runtime, `${SID}.sock`) });
    expect(live.guide).toContain('Claude Glass is open');
    // autoStart defaults to false: nothing launched, no guide
    expect(await sessionStart('other-session', 'startup', '/tmp/proj')).toMatchObject({ open: false, guide: null });
  });

  it('open doesn\'t warn about the mod once it ran in the session', async () => {
    const r = await run(join(root, 'bin/claude-glass'), ['open'], '', { CLAUDE_CODE_SESSION_ID: SID });
    expect(r.stdout).toContain('already open');
    expect(r.stdout).not.toContain("mod isn't running"); // session-start ran for SID above
  });

  it('persists state to disk', async () => {
    await wait(400);
    const saved = JSON.parse(readFileSync(join(home, 'sessions', SID, 'state.json'), 'utf8'));
    expect(saved.instances['markdown-1'].title).toBe('Notes'); // the title given on `new`
  });
});

describe('clean lifecycle', () => {
  it('clears what dead glasses leave behind, and nothing live', async () => {
    // A glass killed outright (no chance to remove its socket).
    const dead = join(runtime, 'aaaaaaaaaaaa.sock');
    const child = spawn(process.execPath, ['-e', 'require("net").createServer().listen(process.argv[1]); setInterval(() => {}, 1000)', dead]);
    for (let i = 0; i < 50 && !existsSync(dead); i++) await wait(50);
    child.kill('SIGKILL');
    await wait(150);
    expect(lstatSync(dead).isSocket()).toBe(true);
    symlinkSync('aaaaaaaaaaaa.sock', join(runtime, 'sess-to-dead.sock'));
    symlinkSync('nowhere.sock', join(runtime, 'sess-dangling.sock'));
    symlinkSync(`${SID}.sock`, join(runtime, 'sess-to-live.sock'));
    const removed = await cleanupRuntime();
    expect(removed.sort()).toEqual(['aaaaaaaaaaaa.sock', 'sess-dangling.sock', 'sess-to-dead.sock']);
    expect(existsSync(join(runtime, 'sess-to-live.sock'))).toBe(true);
    expect(lstatSync(join(runtime, `${SID}.sock`)).isSocket()).toBe(true);
    unlinkSync(join(runtime, 'sess-to-live.sock'));
  });

  it('never turns a glass socket into a link', () => {
    // A running glass's own id, even in folder scope from another folder: left alone.
    expect(bindSession(SID, '/somewhere/else', 'folder')).toBe(SID);
    expect(lstatSync(join(runtime, `${SID}.sock`)).isSocket()).toBe(true);
    // A folder glass id passed as a session: it's a glass, not a session, so no link is made.
    expect(bindSession('0123456789ab', '/somewhere/else', 'folder')).toBe('0123456789ab');
    expect(existsSync(join(runtime, '0123456789ab.sock'))).toBe(false);
  });
});

describe('folder scope', () => {
  const dir = '/tmp/cg-folder-proj';
  const gid = folderGlassId(dir);
  let folder: GlassCore;
  beforeAll(async () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ scope: 'folder' }));
    folder = new GlassCore(gid, dir);
    await folder.listen();
  });
  afterAll(async () => {
    await folder.close();
    writeFileSync(join(home, 'config.json'), JSON.stringify({ scope: 'session' }));
  });

  it('uses the same id as Voice Multiplexer: sha256(dir)[:12]', () => {
    // `printf '%s' <dir> | shasum -a 256 | cut -c1-12`, the relay session id algorithm.
    expect(folderGlassId('/home/user/project')).toBe('9dad1e4e08b0');
    expect(folderGlassId('/tmp/proj/')).toBe(folderGlassId('/tmp/proj'));
  });

  it('every session in the folder (e.g. after /clear) feeds one glass', async () => {
    for (const sid of ['sess-before-clear', 'sess-after-clear']) {
      const r = await sessionStart(sid, sid.endsWith('after-clear') ? 'clear' : 'startup', dir);
      expect(r.guide).toContain('Claude Glass is open');
      await event(sid, { e: 'turn.start', turnId: `turn-${sid}`, text: `hello from ${sid}` }, { e: 'tool.start', tool: 'Bash', id: `t-${sid}`, input: { command: 'ls' } });
    }
    await wait(100);
    const msgs = (folder.state.appState.conversation as any).messages.map((m: any) => m.parts.join(''));
    expect(msgs).toEqual(['hello from sess-before-clear', 'hello from sess-after-clear']);
    const term = (folder.state.appState.terminal as any).entries.map((e: any) => e.summary);
    expect(term).toContainEqual(expect.stringContaining('session clear'));
  });

  it('the CLI resolves the session to its folder glass', async () => {
    const r = await run(join(root, 'bin/claude-glass'), ['view', '--json'], '', { CLAUDE_CODE_SESSION_ID: 'sess-after-clear' });
    const v = JSON.parse(r.stdout);
    expect(v.session.id).toBe(gid);
    expect(v.session.title).toBe('cg-folder-proj'); // folder name, not the full path
  });

  it('switching back to session scope unbinds at the next session start', async () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ scope: 'session' }));
    expect(await sessionStart('sess-after-clear', 'compact', dir)).toMatchObject({ open: false });
    expect(existsSync(join(runtime, 'sess-after-clear.sock'))).toBe(false);
  });
});

describe('stored app values across glasses', () => {
  const cores: GlassCore[] = [];
  const open = async (id: string, cwd: string) => { const c = new GlassCore(id, cwd); await c.listen(); cores.push(c); return c; };
  const until = async (fn: () => boolean) => { for (let i = 0; i < 100 && !fn(); i++) await wait(50); return fn(); }; // the recheck runs every 2s
  beforeAll(() => { cpSync(join(root, 'test/fixtures/apps/tool-count'), join(home, 'apps', 'tool-count'), { recursive: true }); });
  afterAll(async () => { for (const c of cores) await c.close(); rmSync(join(home, 'apps', 'tool-count'), { recursive: true, force: true }); });

  it('project values reach every glass in the folder, global ones every glass, session ones stay put', async () => {
    const a = await open('store-a', '/tmp/store-proj'), b = await open('store-b', '/tmp/store-proj'), other = await open('store-c', '/tmp/store-other');
    a.dispatch({ type: 'instance.create', appType: 'tool-count' });
    a.dispatch({ type: 'app.command', id: 'tool-count', command: 'pin', args: { tool: 'Bash' } });
    a.dispatch({ type: 'app.command', id: 'tool-count', command: 'note', args: { text: 'only here' } });
    a.events([{ e: 'tool.start', tool: 'Read', id: 'r1', input: {} }]);
    const stored = (c: GlassCore) => c.state.stored?.['tool-count'] ?? {};
    expect(await until(() => JSON.stringify(stored(b).pinned) === '["Bash"]')).toBe(true);
    expect(await until(() => stored(other).total === 1)).toBe(true);
    expect(stored(other).pinned).toBeUndefined(); // another project
    expect(stored(b).lastNote).toBeUndefined(); // session: this glass only
    expect(stored(a).lastNote).toBe('only here');
    // A glass opened later starts with what's saved.
    const later = await open('store-d', '/tmp/store-proj');
    expect(stored(later)).toMatchObject({ pinned: ['Bash'], total: 1 });
    // The files are plain JSON per app.
    expect(JSON.parse(readFileSync(join(home, 'stored', 'tool-count.json'), 'utf8'))).toEqual({ total: 1 });
    expect(JSON.parse(readFileSync(join(home, 'projects', folderGlassId('/tmp/store-proj'), 'stored', 'tool-count.json'), 'utf8'))).toEqual({ pinned: ['Bash'] });
  });

  it('the CLI shows, sets and resets them; a reset reaches the other glasses', async () => {
    const env2 = { CLAUDE_CODE_SESSION_ID: 'store-a' };
    const show = await run(join(root, 'bin/claude-glass'), ['stored', 'tool-count', 'set', 'pinned', '["Read","Edit"]'], '', env2);
    expect(show.stdout).toMatch(/pinned\s+project\s+\["Read","Edit"\]/);
    const b = cores.find((c) => c.sessionId === 'store-b')!;
    expect(await until(() => JSON.stringify(b.state.stored?.['tool-count']?.pinned) === '["Read","Edit"]')).toBe(true);
    await run(join(root, 'bin/claude-glass'), ['stored', 'tool-count', 'reset', 'pinned'], '', env2);
    expect(await until(() => b.state.stored?.['tool-count']?.pinned === undefined)).toBe(true);
    const bad = await run(join(root, 'bin/claude-glass'), ['stored', 'tool-count', 'set', 'nope', '1'], '', env2);
    expect(bad.stderr).toContain("isn't a stored value");
  });
});

describe('approvals through the glass (the Action app)', () => {
  const act = (...args: string[]) => run(join(root, 'bin/claude-glass'), ['action', ...args, '--session', SID], args[0] === 'request' ? JSON.stringify({ tool: 'Bash', input: { command: 'rm -rf build' }, canAlways: true }) : '');
  const json = async (p: Promise<{ stdout: string }>) => JSON.parse((await p).stdout);

  it('a request opens a card at the front; the CLI waits; only the glass window can answer', async () => {
    const req = await json(act('request'));
    expect(req).toMatchObject({ id: expect.stringMatching(/^req-/), holdMs: 600_000, summary: '$ rm -rf build' });
    expect(core.state.order[0]).toBe('action');
    const card = (core.state.appState.action as any).requests.find((r: any) => r.id === req.id);
    expect(card).toMatchObject({ status: 'pending', tool: 'Bash', summary: '$ rm -rf build', canAlways: true });
    expect(card.detail).toBeUndefined(); // a short command is all in the summary
    expect(await json(act('wait', req.id, '--ms', '50'))).toEqual({ status: 'pending' });
    // Nothing on the socket can approve: not the CLI's app command, not a raw dispatch.
    const viaCli = await run(join(root, 'bin/claude-glass'), ['app', 'action', 'answer', '--id', req.id, '--choice', 'allow'], '');
    expect(viaCli.stderr).toContain("only the glass's own window");
    expect(() => core.dispatch({ type: 'app.command', id: 'action', command: 'answer', args: { id: req.id, choice: 'allow' } })).toThrow(/only the glass's own window/);
    // The glass window answers (its view runs the command over IPC: from 'ui').
    const waiting = json(act('wait', req.id, '--ms', '5000'));
    await wait(100);
    core.dispatch({ type: 'app.command', id: 'action', command: 'answer', args: { id: req.id, choice: 'always' } }, 'ui');
    expect(await waiting).toEqual({ status: 'answered', choice: 'always', by: 'glass' });
  });

  it('settled in the terminal, it closes with who answered; the card and window go after a moment', async () => {
    const req = await json(act('request'));
    await json(act('close', req.id, '--by', 'terminal', '--choice', 'deny'));
    expect((core.state.appState.action as any).requests.find((r: any) => r.id === req.id).answer).toEqual({ choice: 'deny', by: 'terminal' });
    await wait(1800);
    expect((core.state.appState.action as any).requests).toEqual([]);
    expect(core.state.order).not.toContain('action');
  });

  it('questions (the experiment): off by default; on, the glass answers with an answer per question', async () => {
    const qreq = (input: object) => run(join(root, 'bin/claude-glass'), ['action', 'request', '--session', SID], JSON.stringify({ kind: 'question', tool: 'AskUserQuestion', input }));
    const input = { questions: [
      { question: 'Ship it now?', header: 'Deploy', multiSelect: false, options: [{ label: 'Yes' }, { label: 'Not yet', description: 'keep testing' }] },
      { question: 'Which checks?', header: 'Checks', multiSelect: true, options: [{ label: 'Lint' }, { label: 'Tests' }, { label: 'E2E' }] },
    ] };
    expect(await json(qreq(input))).toEqual({ off: 'questions from the glass are off' });
    await cli('settings', 'set', 'app.action.questions', 'true');
    const req = await json(qreq(input));
    expect(req).toMatchObject({ id: expect.any(String), summary: 'Ship it now?' });
    const card = (core.state.appState.action as any).requests.find((r: any) => r.id === req.id);
    expect(card).toMatchObject({ kind: 'question', questions: [{ question: 'Ship it now?', header: 'Deploy' }, { question: 'Which checks?', multiSelect: true }] });
    expect(() => core.dispatch({ type: 'app.command', id: 'action', command: 'answer', args: { id: req.id, answers: { 'Ship it now?': 'Yes' } } }, 'ui')).toThrow(/every question/);
    const waiting = json(act('wait', req.id, '--ms', '5000'));
    await wait(100);
    core.dispatch({ type: 'app.command', id: 'action', command: 'answer', args: { id: req.id, answers: { 'Ship it now?': 'Not yet', 'Which checks?': 'Lint, Tests' } } }, 'ui');
    expect(await waiting).toEqual({ status: 'answered', choice: 'answered', by: 'glass', answers: { 'Ship it now?': 'Not yet', 'Which checks?': 'Lint, Tests' } });
    // Answered in the terminal's band: the card shows what was chosen there.
    const req2 = await json(qreq({ questions: [input.questions[0]] }));
    await run(join(root, 'bin/claude-glass'), ['action', 'close', req2.id, '--session', SID, '--by', 'terminal', '--answers'], JSON.stringify({ 'Ship it now?': 'Yes' }));
    expect((core.state.appState.action as any).requests.find((r: any) => r.id === req2.id).answer).toEqual({ choice: 'answered', by: 'terminal', answers: { 'Ship it now?': 'Yes' } });
    await cli('settings', 'set', 'app.action.questions', 'false');
  });

  it('off when the user turns approvals off (the mod then leaves it to Claude Code\'s prompt)', async () => {
    await cli('settings', 'set', 'app.action.approvals', 'false');
    expect(await json(act('request'))).toEqual({ off: 'approvals from the glass are off' });
    await cli('settings', 'set', 'app.action.approvals', 'true');
    expect(await json(run(join(root, 'bin/claude-glass'), ['action', 'wait', 'x', '--session', 'no-glass-here'], ''))).toEqual({ status: 'gone' });
  });
});

describe('the Stop button (controls the mod collects)', () => {
  const watchCli = (ms: string) => run(join(root, 'bin/claude-glass'), ['watch', '--session', SID, '--ms', ms], '');
  it('only with interruptButton on and Claude working; the mod collects it with claude-glass watch', async () => {
    core.interrupt(); // off by default: nothing queued
    expect(JSON.parse((await watchCli('50')).stdout)).toEqual([]);
    await cli('settings', 'set', 'interruptButton', 'true');
    core.dispatch({ type: 'session.update', patch: { activity: 'working' } });
    const waiting = watchCli('8000');
    await wait(300);
    core.interrupt();
    expect(JSON.parse((await waiting).stdout)).toEqual([{ kind: 'interrupt', at: expect.any(Number) }]);
    core.dispatch({ type: 'session.update', patch: { activity: 'idle' } });
    core.interrupt(); // idle: nothing to stop
    expect(JSON.parse((await watchCli('50')).stdout)).toEqual([]);
    await cli('settings', 'set', 'interruptButton', 'false');
  });
});

describe('built-in apps ship in the app format', () => {
  it('each compiled dist/apps/<type> folder loads through the custom app loader', () => {
    for (const type of ['image', 'markdown', 'html', 'diff', 'conversation', 'terminal', 'browser']) {
      const app = readApp(join(root, 'dist/apps', type));
      expect(app.type).toBe(type);
      expect(typeof app.init()).toBe('object');
      expect(existsSync(join(root, 'dist/apps', type, 'view.html'))).toBe(true);
    }
  });
});

describe('apps CLI', () => {
  it('apps new creates a starter app that loads', async () => {
    await cli('apps', 'new', 'demo-notes');
    const app = readApp(join(home, 'apps', 'demo-notes'));
    expect(app).toMatchObject({ type: 'demo-notes', title: 'Demo Notes', source: 'user' });
    expect(app.command(app.init(), 'set', { text: 'hi' })).toMatchObject({ text: 'hi' });
    expect(app.guide).toContain('claude-glass app demo-notes set');
  });
  it('apps copy copies a built-in that loads as a user app', async () => {
    await cli('apps', 'copy', 'image');
    const app = readApp(join(home, 'apps', 'image'));
    expect(app).toMatchObject({ type: 'image', source: 'user' });
    expect(existsSync(join(home, 'apps', 'image', 'src', 'view.tsx'))).toBe(true);
  });
  it('apps lists what the live glass loaded', async () => {
    const out = await cli('apps');
    expect(out).toContain('builtin  terminal');
  });
});

describe('turning apps off', () => {
  it('refuses commands to a disabled app and hides it from the catalog', async () => {
    core.setConfig('disabledApps', ['html']);
    const r = await run(join(root, 'bin/claude-glass'), ['new', 'html']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('turned off by the user');
    expect((JSON.parse(await cli('catalog', '--json')) as any[]).some((a) => a.type === 'html')).toBe(false);
    core.setConfig('disabledApps', []);
    expect(await cli('new', 'html')).toMatch(/^html-/);
  });
});

describe('nested view', () => {
  it('turns the glass into one nested page and refuses layouts', async () => {
    core.setConfig('nestedView', true);
    const v = JSON.parse(await cli('view', '--json'));
    expect(v.desktops).toHaveLength(1);
    expect(v.desktops[0].layout).toBe('nested');
    const r = await run(join(root, 'bin/claude-glass'), ['layout', '1', 'grid']);
    expect(r.stderr).toContain('nested view');
    expect(JSON.parse(await cli('view', '--json')).desktops[0].layout).toBe('nested');
    core.setConfig('nestedView', false);
    const bad = await run(join(root, 'bin/claude-glass'), ['layout', '1', 'nested']);
    expect(bad.status).not.toBe(0);
  });
});

describe('history mode', () => {
  it('refuses window moves so the timeline stays in order', async () => {
    core.dispatch({ type: 'settings.set', key: 'windowMode', value: 'history' });
    const r = await run(join(root, 'bin/claude-glass'), ['window', 'move', 'terminal', '0']);
    expect(r.stderr).toContain('history mode');
    expect(JSON.parse(await cli('state', '--json')) && (await run(join(root, 'bin/claude-glass'), ['open'])).stdout).toContain('history mode on');
    core.dispatch({ type: 'settings.set', key: 'windowMode', value: 'live' });
  });
});

describe('settings from the CLI', () => {
  it('lists every setting with what it does, and Claude is told how to change them', async () => {
    const out = await cli('settings');
    expect(out).toContain('nestedView');
    expect(out).toContain('session.windowMode');
    await cli('settings', 'set', 'windowOpacity', '0.5');
    expect(core.config.windowOpacity).toBe(0.5);
    expect(await cli('open')).toContain('claude-glass settings set <key> <value>');
  });
  it("apps' own settings: listed, set by app.<type>.<key>, validated against the manifest", async () => {
    expect(await cli('settings')).toMatch(/app\.image\.gridSize\s+12/);
    await cli('settings', 'set', 'app.image.gridSize', '4');
    expect(core.config.appSettings.image).toEqual({ gridSize: 4 });
    const bad = await run(join(root, 'bin/claude-glass'), ['settings', 'set', 'app.image.gridSize', '400']);
    expect(bad.stderr).toContain('between');
    const none = await run(join(root, 'bin/claude-glass'), ['settings', 'set', 'app.image.nope', '1']);
    expect(none.stderr).toContain('gridSize');
    await cli('settings', 'set', 'app.image.gridSize', '12');
  });
  it('background colors: the user sets their own; Claude signals per session, validated', async () => {
    await cli('settings', 'set', 'backgroundColors', '#112233,445566');
    expect(core.config.backgroundColors).toEqual(['#112233', '#445566']);
    expect(await cli('background', '--colors', '#c0392b,#e67e22')).toContain('#c0392b, #e67e22');
    expect(core.state.settings.backgroundColors).toEqual(['#c0392b', '#e67e22']);
    const bad = await run(join(root, 'bin/claude-glass'), ['background', '--colors', 'red;}body{']);
    expect(bad.stderr).toContain('not a hex color');
    expect(core.state.settings.backgroundColors).toEqual(['#c0392b', '#e67e22']);
    expect(await cli('background', 'reset')).toContain("the user's own");
    expect(core.state.settings.backgroundColors).toBeUndefined();
    expect(await cli('open')).toContain('claude-glass background --colors');
    await cli('settings', 'set', 'backgroundColors', '');
    expect(core.config.backgroundColors).toEqual([]);
  });
});

describe('presets from the CLI', () => {
  it('save, list, apply, default for new glasses, delete', async () => {
    core.dispatch({ type: 'window.tuck', id: 'terminal', edge: 'bottom' });
    core.dispatch({ type: 'tuck.keep', edge: 'bottom', keep: true });
    expect(await cli('preset', 'save', 'Voice frame', '--description', 'terminal along the bottom')).toContain('Saved preset "Voice frame"');
    core.dispatch({ type: 'window.untuck', id: 'terminal' });
    expect(await cli('preset', 'list')).toMatch(/Voice frame — terminal along the bottom\n\s+docks bottom: terminal/);
    expect(await cli('preset', 'apply', 'Voice frame')).toContain('applied');
    expect(core.state.tucked?.bottom).toEqual(['terminal']);
    await cli('preset', 'default', 'Voice frame');
    // A brand-new glass starts from the default preset.
    const fresh = new GlassCore('preset-fresh', '/tmp/proj');
    expect(fresh.state.tucked?.bottom).toEqual(['terminal']);
    expect(fresh.state.tuckKeep).toContain('bottom');
    await cli('preset', 'delete', 'Voice frame');
    expect(core.config.defaultPreset).toBe('');
    expect(await cli('preset', 'list')).toContain('No presets yet');
    core.dispatch({ type: 'window.untuck', id: 'terminal' });
  });
});

describe('file copies', () => {
  it('prunes copies no window refers to, keeping recent ones', async () => {
    const dir = join(home, 'sessions', SID, 'files');
    mkdirSync(dir, { recursive: true });
    const old = Date.now() / 1000 - 3600;
    for (const n of ['orphan.png', 'kept.png', 'fresh.png']) writeFileSync(join(dir, n), 'x');
    utimesSync(join(dir, 'orphan.png'), old, old);
    utimesSync(join(dir, 'kept.png'), old, old);
    core.dispatch({ type: 'instance.create', appType: 'image', id: 'prune-test' });
    core.dispatch({ type: 'app.command', id: 'prune-test', command: 'add', args: { file: join(dir, 'kept.png') } });
    core.pruneFiles();
    const left = readdirSync(dir);
    expect(left).not.toContain('orphan.png');
    expect(left).toEqual(expect.arrayContaining(['fresh.png', 'kept.png']));
    core.dispatch({ type: 'instance.delete', id: 'prune-test' });
  });
});

describe('view for Claude', () => {
  it('reports display modes, window positions and docked windows (edges and corners)', async () => {
    core.dispatch({ type: 'window.tuck', id: 'terminal', edge: 'left' });
    core.dispatch({ type: 'tuck.keep', edge: 'left', keep: true });
    await cli('window', 'dock', 'conversation', 'top-right');
    core.dispatch({ type: 'tuck.size', edge: 'top-right', size: 360, height: 240 });
    const v = JSON.parse(await cli('view', '--json'));
    expect(v.display).toMatchObject({ nestedView: false, windowMode: 'live' });
    expect(v.desktops[0].windows[0].rect).toMatchObject({ x: 0, y: 0 });
    expect(v.sidebars.left).toMatchObject({ open: true, windows: ['terminal'] });
    expect(v.sidebars['top-right']).toMatchObject({ open: false, size: 360, height: 240, windows: ['conversation'] });
    const text = await cli('view');
    expect(text).toMatch(/Docked left \(kept open, \d+px\): terminal/);
    expect(text).toMatch(/Docked top-right \(hidden until hovered\): conversation/);
    await cli('window', 'undock', 'conversation');
    core.dispatch({ type: 'window.untuck', id: 'terminal' });
  });
});

describe('renamed settings', () => {
  it('the old dock* names still set the launcher settings', async () => {
    await cli('settings', 'set', 'dockAutoHide', 'true');
    expect(core.config.launcherAutoHide).toBe(true);
    expect('dockAutoHide' in core.config).toBe(false);
    await cli('settings', 'set', 'launcherAutoHide', 'false');
    await cli('settings', 'set', 'dockOpen', 'hover');
    expect(core.config.dockOpen).toBe('hover');
    await expect(cli('settings', 'set', 'dockOpen', 'sometimes')).rejects.toThrow(/click or hover/);
    await cli('settings', 'set', 'dockOpen', 'click');
  });
});
