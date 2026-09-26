// Core server in plain Node, driven by the real built CLI and the bash hook forwarder.
// Requires `npm run build` first (dist/cli.js).
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { folderGlassId } from '../../src/core/binding';
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
    expect(term.entries.map((e: any) => e.tool)).toEqual(['Read', 'Edit', 'Bash']);
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
    expect(saved.instances['markdown-1'].title).toBe('Notes');
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
    expect(folderGlassId('/Users/user/claude-glass')).toBe('20ca07fd5ec9');
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
