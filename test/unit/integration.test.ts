// Core server in plain Node, driven by the real built CLI and the bash hook forwarder.
// Requires `npm run build` first (dist/cli.js).
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CanvasCore } from '../../src/core/server';

const root = join(__dirname, '../..');
const home = mkdtempSync(join(tmpdir(), 'cc-home-'));
const runtime = mkdtempSync('/tmp/cc-rt-');
process.env.CLAUDE_CANVAS_HOME = home;
process.env.CLAUDE_CANVAS_RUNTIME = runtime;
const SID = 'itest-session';
const env = { ...process.env, CLAUDE_CANVAS_HOME: home, CLAUDE_CANVAS_RUNTIME: runtime, CLAUDE_CODE_SESSION_ID: SID };

// Async on purpose: the server lives in this process, a sync exec would deadlock it.
function run(cmd: string, args: string[], input?: string): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((res) => {
    const p = spawn(cmd, args, { env });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (status) => res({ status: status ?? -1, stdout: stdout.trim(), stderr }));
    p.stdin.end(input ?? '');
  });
}
async function cli(...args: string[]): Promise<string> {
  const r = await run(join(root, 'bin/claude-canvas'), args);
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout;
}
async function hook(payload: object) {
  const r = await run(join(root, 'scripts/hook-forward.sh'), [], JSON.stringify(payload));
  expect(r.status).toBe(0);
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let core: CanvasCore;
beforeAll(async () => {
  if (!existsSync(join(root, 'dist/cli.js'))) throw new Error('run npm run build first');
  core = new CanvasCore(SID, '/tmp/proj');
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
    const r = await run(join(root, 'bin/claude-canvas'), ['window', 'open', 'nope']);
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

  it('status lists this canvas as open', async () => {
    expect(await cli('status')).toMatch(/● open\s+itest-session/);
  });

  it('catalog hides internal commands', async () => {
    const c = JSON.parse(await cli('catalog', '--json'));
    const term = c.find((a: any) => a.type === 'terminal');
    expect(Object.keys(term.commands)).toEqual(['log', 'clear']);
  });
});

describe('hook forwarder', () => {
  it('forwards real payloads into the canvas', async () => {
    const payloads = readFileSync(join(root, 'test/fixtures/hook-payloads.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    for (const p of payloads) await hook({ ...p, session_id: SID });
    await wait(100);
    const term = core.state.appState.terminal as any;
    expect(term.entries.map((e: any) => e.tool)).toEqual(['Read', 'Edit', 'Bash']);
    expect((core.state.appState.conversation as any).messages.length).toBe(3);
    expect(core.state.appState.changes).toBeTruthy();
  });

  it('is a fast no-op when no canvas exists for the session', async () => {
    const t = Date.now();
    await hook({ hook_event_name: 'PreToolUse', session_id: 'no-such-session', tool_name: 'Bash' });
    expect(Date.now() - t).toBeLessThan(500);
  });

  it('persists state to disk', async () => {
    await wait(400);
    const saved = JSON.parse(readFileSync(join(home, 'sessions', SID, 'state.json'), 'utf8'));
    expect(saved.instances['markdown-1'].title).toBe('Notes');
  });
});
