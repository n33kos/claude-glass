// Visual E2E: launch Electron against a temp home, seed content, capture screenshots.
// Screenshots land in test/screenshots/ — LOOK at them after UI changes.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { cli, hook, seed } from './seed.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const shots = join(root, 'test/screenshots');
mkdirSync(shots, { recursive: true });
const home = mkdtempSync(join(tmpdir(), 'cc-e2e-home-'));
const runtime = mkdtempSync('/tmp/cc-e2e-rt-');
const SID = 'e2e-session';
const env = { ...process.env, CLAUDE_CANVAS_HOME: home, CLAUDE_CANVAS_RUNTIME: runtime, CLAUDE_CODE_SESSION_ID: SID };
delete env.ELECTRON_RUN_AS_NODE;

const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (cond, msg) => { if (!cond) { failures++; console.error(`✗ ${msg}`); } else console.log(`✓ ${msg}`); };

const app = await electron.launch({ args: [join(root, 'dist/main.js'), '--session', SID, '--cwd', root], env });
try {
  const page = await app.firstWindow();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForSelector('.window');
  await sleep(600);
  await page.screenshot({ path: join(shots, '01-empty.png') });
  check((await page.locator('.window').count()) === 2, 'starts with conversation + terminal');

  await seed(env);
  await sleep(1200);
  await page.screenshot({ path: join(shots, '02-seeded.png') });
  const view = await cli(env, 'view');
  console.log(view);
  check(view.includes('Desktop 2'), 'overflow spills onto desktop 2');
  check((await page.locator('.t-entry').count()) >= 5, 'terminal shows tool calls');
  check((await page.locator('.msg.assistant').count()) === 2, 'conversation shows assistant messages');

  // Desktop 2
  await page.locator('.pager button').nth(1).click();
  await sleep(700);
  await page.screenshot({ path: join(shots, '03-desktop2.png') });
  const viewing = await cli(env, 'view');
  check(viewing.includes('user is viewing desktop 2'), 'core knows which desktop the user is viewing');
  await page.locator('.pager button').nth(0).click();
  await sleep(600);

  // Layout menu + switch to grid
  await page.locator('.window').first().locator('.light.layout').click();
  await sleep(200);
  await page.screenshot({ path: join(shots, '04-layout-menu.png') });
  await page.locator('.layout-menu button', { hasText: 'Grid' }).click();
  await sleep(700);
  await page.screenshot({ path: join(shots, '05-grid.png') });
  check((await cli(env, 'view')).includes('Desktop 1 [grid]'), 'layout picker changes the desktop layout');

  // Drag first window onto the third slot
  const before = JSON.parse(await cli(env, 'view', '--json')).desktops[0].windows.map((w) => w.id);
  const t0 = await page.locator('.window').filter({ has: page.locator(`[data-window="${before[0]}"]`) }).count();
  const src = page.locator(`[data-window="${before[0]}"] .titlebar`);
  const dst = page.locator(`[data-window="${before[2]}"]`);
  const sb = await src.boundingBox(), db = await dst.boundingBox();
  await page.mouse.move(sb.x + sb.width / 2, sb.y + 18);
  await page.mouse.down();
  await page.mouse.move(db.x + db.width / 2, db.y + db.height / 2, { steps: 12 });
  await sleep(150);
  await page.screenshot({ path: join(shots, '06-dragging.png') });
  await page.mouse.up();
  await sleep(600);
  const after = JSON.parse(await cli(env, 'view', '--json')).desktops[0].windows.map((w) => w.id);
  check(after[2] === before[0], `drag moves ${before[0]} to slot 3 (got ${after.join(',')})`);
  void t0;

  // Settings via dock
  await page.locator('.dock-item[title="Settings"]').click();
  await sleep(700);
  await page.screenshot({ path: join(shots, '07-settings.png') });
  check((await page.locator('.settings').count()) === 1, 'settings opens from the dock');

  // Close a window via traffic light, reopen from dock
  await page.locator('[data-window="settings"] .light.close').click();
  await sleep(500);
  check(!(await cli(env, 'view')).match(/\bsettings\s+settings/), 'close button closes the window');

  // Streaming + working state
  await hook(env, { hook_event_name: 'UserPromptSubmit', prompt: 'Show me the final diff.' });
  await hook(env, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm run build' }, tool_use_id: 'live1' });
  await hook(env, { hook_event_name: 'MessageDisplay', message_id: 'live', turn_id: 't2', index: 0, final: false, delta: 'Building now, then I will' });
  await sleep(500);
  await page.screenshot({ path: join(shots, '08-working.png') });
  check((await page.locator('.presence-working').count()) === 1, 'presence shows working');

  // Session ended
  await hook(env, { hook_event_name: 'SessionEnd', reason: 'other' });
  await sleep(300);
  check((await page.locator('.presence-ended').count()) === 1, 'presence shows session ended');

  check(errors.length === 0, `no renderer errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
} finally {
  await cli(env, 'close').catch(() => {});
  await sleep(300);
  await app.close().catch(() => {});
  rmSync(runtime, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall e2e checks passed');
console.log(`screenshots: ${shots}`);
process.exit(failures ? 1 : 0);
