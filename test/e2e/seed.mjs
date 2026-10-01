// Seeds a running glass with realistic content through the real CLI, sending the events the mod sends.
// Shared by the e2e screenshot run and `npm run demo`.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

export function run(cmd, args, env, input = '') {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { env });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => (code === 0 ? res(out.trim()) : rej(new Error(`${cmd} ${args.join(' ')}: ${err}`))));
    p.stdin.end(input);
  });
}

export const cli = (env, ...args) => run(join(root, 'bin/claude-glass'), args, env);
// The project the seeded session "works in" (paths in the terminal/diffs show relative to it).
export const project = (env) => env.SEED_PROJECT || root;
/** What the glass mod does: hand session events (src/core/events.ts) to the glass through the CLI. */
export const event = (env, ...events) => run(join(root, 'bin/claude-glass'), ['event'], env, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let n = 0;
async function tool(env, tool, input, result, durationMs = 120) {
  const id = `toolu_seed_${++n}`;
  await event(env, { e: 'tool.start', tool, input, id, cwd: project(env) });
  await event(env, { e: 'tool.end', tool, input, result, id, durationMs, cwd: project(env) });
}

async function say(env, text, id = `msg_${++n}`) {
  // Stream it in 3 steps like the mod does: the text so far each time.
  const ends = [Math.ceil(text.length / 3), Math.ceil((2 * text.length) / 3), text.length];
  for (const end of ends) await event(env, { e: 'text', id, turnId: 't', text: text.slice(0, end), final: end === text.length });
}

export async function seed(env) {
  const f = (p) => join(project(env), p);
  await event(env, { e: 'turn.start', turnId: 't', text: 'The session list flickers when a glass reconnects. Can you find out why and fix it?' });
  await say(env, "I'll trace how the session list re-renders on reconnect. Starting with the socket client and the store.");
  await tool(env, 'Grep', { pattern: 'reconnect', path: f('src') }, { mode: 'files_with_matches', filenames: ['src/cli/client.ts', 'src/core/server.ts'], numFiles: 2 });
  await tool(env, 'Read', { file_path: f('src/core/server.ts') }, { type: 'text', file: { filePath: f('src/core/server.ts'), numLines: 188 } });
  await tool(env, 'Bash', { command: 'npm test -- --reporter=dot', description: 'Run tests' }, { stdout: ' RUN  v5.0.2\n\n ·························\n\n Test Files  2 passed (2)\n      Tests  27 passed (27)\n   Duration  1.36s', stderr: '' }, 2140);
  await tool(env, 'Edit', { file_path: f('src/core/server.ts'), old_string: 'a', new_string: 'b' }, {
    structuredPatch: [{ oldStart: 38, oldLines: 6, newStart: 38, newLines: 8, lines: [
      '   private commit(next: GlassState) {',
      '-    if (next === this.state) return;',
      '+    // Skip no-op commits so reconnects don\'t re-render the whole list.',
      '+    if (next === this.state || shallowEqual(next, this.state)) return;',
      '     this.state = next;',
      '     this.scheduleSave();',
      '-    for (const fn of this.listeners) fn(this.state, this.config);',
      '+    for (const fn of this.listeners) fn(this.state, this.config);',
      '+    this.lastCommit = Date.now();',
      '   }',
    ] }],
  });
  await tool(env, 'Edit', { file_path: f('src/cli/client.ts'), old_string: 'a', new_string: 'b' }, {
    structuredPatch: [{ oldStart: 9, oldLines: 3, newStart: 9, newLines: 3, lines: [
      "     const sock = net.connect(socket);",
      "-    const t = setTimeout(() => { sock.destroy(); reject(new Error('timeout')); }, timeoutMs);",
      "+    const t = setTimeout(() => { sock.destroy(); reject(new Error('glass did not respond (timeout)')); }, timeoutMs);",
      "     sock.setEncoding('utf8');",
    ] }],
  });
  await tool(env, 'Bash', { command: 'git diff --stat' }, { stdout: ' src/cli/client.ts  | 2 +-\n src/core/server.ts | 6 ++++--\n 2 files changed, 5 insertions(+), 3 deletions(-)', stderr: '' });
  await tool(env, 'Bash', { command: 'npm run lint' }, { stdout: '', stderr: 'src/core/server.ts:41:43  error  \'shallowEqual\' is not defined  no-undef\n\n✖ 1 problem (1 error, 0 warnings)' }, 900);
  await say(env, 'Found it. Every reconnect replays a `ping`, and **`commit()` fired listeners even when nothing changed**, so the list re-rendered from scratch.\n\nI added a no-op check. Lint caught a missing import; fixing that next.');

  const tmp = mkdtempSync(join(tmpdir(), 'cc-seed-'));
  const plan = join(tmp, 'PLAN.md');
  writeFileSync(plan, `# Fix: session list flicker on reconnect

## What's happening
Reconnects send a \`ping\`, which commits an **identical** state. Listeners fire, the renderer
receives a full patch, and React remounts every row.

## Plan
1. Skip no-op commits in \`GlassCore.commit()\`
2. Import \`shallowEqual\` from \`core/util\`
3. Add a regression test: 50 pings → 0 renders
4. Verify visually with the e2e screenshots

| Step | Risk | Status |
|---|---|---|
| No-op check | Low | Done |
| Import | None | In progress |
| Regression test | Low | Todo |

> Out of scope: batching patches across windows.
`);
  await cli(env, 'show', plan, '--title', 'Plan');

  const html = join(tmp, 'renders.html');
  writeFileSync(html, `<!doctype html><html><head><style>
  body{margin:0;font:13px -apple-system,system-ui;background:#fbfaf7;color:#222;padding:22px}
  h2{margin:0 0 4px;font-size:16px} p{margin:0 0 16px;color:#666}
  .row{display:flex;align-items:center;gap:10px;margin:8px 0} .row b{width:110px;font-weight:500}
  .bar{height:18px;border-radius:4px;background:#e66a4f;transition:width 1s} .after{background:#3a8f6b}
  </style></head><body>
  <h2>Renders per reconnect</h2><p>Measured over 50 reconnects</p>
  <div class="row"><b>Before</b><div class="bar" style="width:0" data-w="92%"></div><span>50</span></div>
  <div class="row"><b>After</b><div class="bar after" style="width:0" data-w="4%"></div><span>2</span></div>
  <script>requestAnimationFrame(()=>document.querySelectorAll('.bar').forEach(b=>b.style.width=b.dataset.w))</script>
  </body></html>`);
  await cli(env, 'show', html, '--title', 'Render count');
  await sleep(50);
}
