// Core server in plain Node, driven by the real built CLI and the bash hook forwarder.
// Requires `npm run build` first (dist/cli.js).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { folderGlassId } from '../../src/core/binding';
import { readMod } from '../../src/core/mods';
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
async function hook(payload: object) {
  const r = await run(join(root, 'scripts/hook-forward.sh'), [], JSON.stringify(payload));
  expect(r.status).toBe(0);
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
    expect(await cli('show', png)).toBe('image-1 (image)');
    const st = core.state.appState['image-1'] as any;
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

describe('hook forwarder', () => {
  it('forwards real payloads into the glass', async () => {
    const payloads = readFileSync(join(root, 'test/fixtures/hook-payloads.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    for (const p of payloads) await hook({ ...p, session_id: SID });
    await wait(100);
    const term = core.state.appState.terminal as any;
    expect(term.entries.map((e: any) => e.tool)).toEqual(['Read', 'Edit', 'Bash', 'WebSearch', 'WebFetch']);
    expect((core.state.appState.conversation as any).messages.length).toBe(3);
    expect(core.state.appState.changes).toBeTruthy();
  });

  it('is a fast no-op when no glass exists for the session', async () => {
    const t = Date.now();
    await hook({ hook_event_name: 'PreToolUse', session_id: 'no-such-session', tool_name: 'Bash' });
    expect(Date.now() - t).toBeLessThan(500);
  });

  it('session-start hook injects the guide only when the glass is live', async () => {
    const live = await run(join(root, 'bin/claude-glass'), ['session-start-hook'], JSON.stringify({ session_id: SID, source: 'compact', cwd: '/tmp/proj' }));
    expect(JSON.parse(live.stdout).hookSpecificOutput.additionalContext).toContain('Claude Glass is open');
    const off = await run(join(root, 'bin/claude-glass'), ['session-start-hook'], JSON.stringify({ session_id: 'other-session', source: 'startup', cwd: '/tmp/proj' }));
    expect(off.stdout).toBe(''); // autoStart defaults to false: nothing injected, nothing launched
  });

  it('persists state to disk', async () => {
    await wait(400);
    const saved = JSON.parse(readFileSync(join(home, 'sessions', SID, 'state.json'), 'utf8'));
    expect(saved.instances['markdown-1'].title).toBe('Notes'); // the title given on `new`
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
      const r = await run(join(root, 'bin/claude-glass'), ['session-start-hook'], JSON.stringify({ hook_event_name: 'SessionStart', session_id: sid, source: sid.endsWith('after-clear') ? 'clear' : 'startup', cwd: dir }));
      expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toContain('Claude Glass is open');
      await hook({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: `hello from ${sid}` });
      await hook({ hook_event_name: 'PreToolUse', session_id: sid, tool_name: 'Bash', tool_use_id: `t-${sid}`, tool_input: { command: 'ls' } });
      await wait(50);
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

  it('switching back to session scope unbinds on the next SessionStart', async () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ scope: 'session' }));
    const r = await run(join(root, 'bin/claude-glass'), ['session-start-hook'], JSON.stringify({ session_id: 'sess-after-clear', source: 'resume', cwd: dir }));
    expect(r.stdout).toBe('');
    expect(existsSync(join(runtime, 'sess-after-clear.sock'))).toBe(false);
  });
});

describe('built-in apps ship as mods', () => {
  it('each compiled dist/apps/<type> folder loads through the mod loader', () => {
    for (const type of ['image', 'markdown', 'html', 'diff', 'conversation', 'terminal', 'browser']) {
      const app = readMod(join(root, 'dist/apps', type));
      expect(app.type).toBe(type);
      expect(typeof app.init()).toBe('object');
      expect(existsSync(join(root, 'dist/apps', type, 'view.html'))).toBe(true);
    }
  });
});

describe('apps CLI', () => {
  it('apps new creates a starter mod that loads', async () => {
    await cli('apps', 'new', 'demo-notes');
    const app = readMod(join(home, 'apps', 'demo-notes'));
    expect(app).toMatchObject({ type: 'demo-notes', title: 'Demo Notes', source: 'user' });
    expect(app.command(app.init(), 'set', { text: 'hi' })).toMatchObject({ text: 'hi' });
    expect(app.guide).toContain('claude-glass app demo-notes set');
  });
  it('apps copy copies a built-in that loads as a user mod', async () => {
    await cli('apps', 'copy', 'image');
    const app = readMod(join(home, 'apps', 'image'));
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
    expect(await cli('preset', 'list')).toMatch(/Voice frame — terminal along the bottom\n\s+sidebars bottom: terminal/);
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

describe('tool reminder hook', () => {
  const remind = async (command: string, session = SID) =>
    (await run(join(root, 'scripts/tool-reminder.sh'), [], JSON.stringify({ session_id: session, tool_input: { command } }))).stdout;
  it('reminds only for shell file I/O, only while a glass is open, and can be turned off', async () => {
    expect(JSON.parse(await remind('sed -n 1,40p src/core/reducer.ts')).hookSpecificOutput.additionalContext).toContain('Read tool');
    expect(await remind("cat > notes.md <<'EOF'")).toContain('Edit/Write');
    for (const ok of ['npm test 2>&1 | tail -3', 'grep -n reduce src', 'git commit -qm "a > b.c"', 'claude-glass app x log --text "cat a.ts"']) expect(await remind(ok)).toBe('');
    expect(await remind('cat a.ts', 'no-glass-here')).toBe('');
    await cli('settings', 'set', 'toolReminders', 'false');
    expect(await remind('cat a.ts')).toBe('');
    await cli('settings', 'set', 'toolReminders', 'true');
  });
});

describe('view for Claude', () => {
  it('reports display modes, window positions and pinned sidebars', async () => {
    core.dispatch({ type: 'window.tuck', id: 'terminal', edge: 'left' });
    core.dispatch({ type: 'tuck.keep', edge: 'left', keep: true });
    const v = JSON.parse(await cli('view', '--json'));
    expect(v.display).toMatchObject({ nestedView: false, windowMode: 'live' });
    expect(v.desktops[0].windows[0].rect).toMatchObject({ x: 0, y: 0 });
    expect(v.sidebars.left).toMatchObject({ open: true, windows: ['terminal'] });
    expect(await cli('view')).toMatch(/Pinned left sidebar \(kept open, \d+px\): terminal/);
    core.dispatch({ type: 'window.untuck', id: 'terminal' });
  });
});
