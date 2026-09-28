// Visual E2E: launch Electron against a temp home, seed content, capture screenshots.
// Screenshots land in test/screenshots/ — LOOK at them after UI changes.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, _electron as electron } from 'playwright';
import { cli, hook, seed } from './seed.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const shots = join(root, 'test/screenshots');
mkdirSync(shots, { recursive: true });
const home = mkdtempSync(join(tmpdir(), 'cc-e2e-home-'));
const runtime = mkdtempSync('/tmp/cc-e2e-rt-');
// Example mods (auto-open off so they don't reshuffle the layout checks; opened near the end).
cpSync(join(root, 'test/fixtures/mods'), join(home, 'apps'), { recursive: true });
{
  const mf = join(home, 'apps/tool-count/glass-app.json');
  writeFileSync(mf, JSON.stringify({ ...JSON.parse(readFileSync(mf, 'utf8')), autoOpen: false }));
}
const SID = 'e2e-session';
const env = { ...process.env, CLAUDE_GLASS_HOME: home, CLAUDE_GLASS_RUNTIME: runtime, CLAUDE_CODE_SESSION_ID: SID };
delete env.ELECTRON_RUN_AS_NODE;

const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
// App views live in sandboxed frames; this finds one app's frame by instance id.
const appFrame = (page, id) => page.frameLocator(`[data-window="${id}"] iframe.appframe`);
const check = (cond, msg) => { if (!cond) { failures++; console.error(`✗ ${msg}`); } else console.log(`✓ ${msg}`); };

// Permissions: two identical demo apps, one declaring network + storage + microphone, one declaring nothing.
const permSrv = createServer((_q, r) => { r.setHeader('access-control-allow-origin', '*'); r.end('hello'); });
await new Promise((res) => permSrv.listen(0, '127.0.0.1', res));
const permOrigin = `http://127.0.0.1:${permSrv.address().port}`;
const demoView = `<!doctype html><meta charset="utf-8"><body style="color:#fff;font:14px system-ui;padding:12px">
<div id="net"></div><div id="store"></div><div id="mic"></div>
<script src="glass-app://sdk/glass-app.js"></script><script>
fetch('${permOrigin}/').then((r) => r.text()).then((t) => { net.textContent = 'net:' + t; }).catch(() => { net.textContent = 'net:blocked'; });
try { const n = Number(localStorage.getItem('n') || 0) + 1; localStorage.setItem('n', n); store.textContent = 'store:' + n; } catch { store.textContent = 'store:blocked'; }
navigator.permissions.query({ name: 'microphone' }).then((p) => { mic.textContent = 'mic:' + p.state; }).catch((e) => { mic.textContent = 'mic:' + e.name; });
</script>`;
for (const [type, permissions] of [['perm-demo', { network: [permOrigin], storage: true, microphone: true }], ['noperm-demo', undefined]]) {
  mkdirSync(join(home, 'apps', type), { recursive: true });
  writeFileSync(join(home, 'apps', type, 'glass-app.json'), JSON.stringify({ apiVersion: 1, type, title: type, singleton: true, permissions }));
  writeFileSync(join(home, 'apps', type, 'core.js'), 'exports.init = () => ({}); exports.command = (s) => s;');
  writeFileSync(join(home, 'apps', type, 'view.html'), demoView);
}

const app = await electron.launch({ args: ['--use-fake-device-for-media-stream', join(root, 'dist/main.js'), '--session', SID, '--cwd', root], env });
try {
  const page = await app.firstWindow();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForSelector('.window');
  await sleep(600);
  await page.screenshot({ path: join(shots, '01-empty.png') });
  check((await page.locator('.window').count()) === 2, 'starts with conversation + terminal');
  check((await page.locator('.titlebar .wid').count()) === 0, 'title bars show the title once (no repeated id)');
  // Mouse wheel outside windows switches desktops (setting on by default).
  {
    await cli(env, 'new', 'markdown', '--title', 'Wheel A');
    await cli(env, 'new', 'markdown', '--title', 'Wheel B');
    await cli(env, 'layout', '1', 'split');
    await sleep(400);
    const topbar = await page.locator('.topbar').boundingBox();
    await page.mouse.move(topbar.x + topbar.width / 2, topbar.y + topbar.height / 2);
    await page.mouse.wheel(0, 120);
    await sleep(700);
    const viewing = JSON.parse(await cli(env, 'view', '--json')).userViewingDesktop;
    check(viewing === 1, `wheel over the top bar moves to the next desktop (viewing ${viewing + 1})`);
    await page.keyboard.press('Meta+ArrowLeft');
    await sleep(800);
    // Select to interact (on by default): the wheel over an unselected window walks desktops too;
    // a click selects it (ringed) and then its content scrolls instead; Esc deselects.
    const vw = await page.evaluate(() => innerWidth);
    let first, fb;
    for (const w of await page.locator('.strip .window').all()) { const b = await w.boundingBox(); if (b && b.x >= 0 && b.x + b.width <= vw) { first = w; fb = b; break; } }
    await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2);
    await page.mouse.wheel(0, 120);
    await sleep(800);
    const overWindow = JSON.parse(await cli(env, 'view', '--json')).userViewingDesktop;
    const probe = await page.evaluate(([x, y]) => { const el = document.elementFromPoint(x, y); return `${document.querySelectorAll('.body-shield').length} shields; at point: ${el?.className}`; }, [fb.x + fb.width / 2, fb.y + fb.height / 2]);
    check(overWindow === 1, `wheel over an unselected window moves to the next desktop (viewing ${overWindow + 1}; ${probe})`);
    await page.keyboard.press('Meta+ArrowLeft');
    await sleep(800);
    await page.mouse.click(fb.x + fb.width / 2, fb.y + fb.height / 2);
    await sleep(200);
    check((await first.evaluate((el) => el.classList.contains('selected'))) && (await first.locator('.body-shield').count()) === 0, 'clicking a window selects it (ringed, unshielded)');
    await page.screenshot({ path: join(shots, '01b-selected.png') });
    await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2);
    await page.mouse.wheel(0, 120);
    await sleep(800);
    const stay = JSON.parse(await cli(env, 'view', '--json')).userViewingDesktop;
    check(stay === 0, `wheel over the selected window scrolls it, not the desktops (viewing ${stay + 1})`);
    await page.keyboard.press('Escape');
    await sleep(150);
    check((await page.locator('.window.selected').count()) === 0, 'Esc deselects');
    // The rest of the suite drives window content directly.
    await cli(env, 'settings', 'set', 'selectToInteract', 'false');
    await sleep(300);
    for (const w of JSON.parse(await cli(env, 'view', '--json')).desktops.flatMap((d) => d.windows)) if (w.title.startsWith('Wheel')) await cli(env, 'window', 'close', w.id);
    await cli(env, 'layout', '1', 'grid');
    await sleep(300);
  }

  await seed(env);
  await sleep(1200);
  await page.screenshot({ path: join(shots, '02-seeded.png') });
  {
    const pos = () => page.locator('.bokeh').first().evaluate((e) => getComputedStyle(e).transform);
    const a = await pos();
    await sleep(1500);
    const b = await pos();
    check((await page.locator('.wallpaper.drifting .bokeh').count()) >= 2 && a !== b, 'background bokeh drifts');
  }
  const view = await cli(env, 'view');
  console.log(view);
  check(view.includes('Desktop 2'), 'overflow spills onto desktop 2');
  check((await appFrame(page, 'terminal').locator('.t-entry').count()) >= 5, 'terminal shows tool calls');
  check((await appFrame(page, 'conversation').locator('.msg.assistant').count()) === 2, 'conversation shows assistant messages');

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

  // Image viewer, served through the glass-file protocol
  await cli(env, 'show', join(shots, '01-empty.png'), '--title', 'Screenshot');
  await sleep(800);
  await page.screenshot({ path: join(shots, '06b-image.png') });
  const imgFrame = page.frameLocator('iframe[src="glass-app://image/view.html"]');
  await imgFrame.locator('.imageview img').waitFor({ timeout: 5000 });
  await sleep(300);
  const imgOk = await imgFrame.locator('.imageview img').evaluate((img) => img.complete && img.naturalWidth > 0);
  check(imgOk, 'image viewer loads the stored image');

  // Lightbox: click opens a full-window overlay, wheel zooms, Esc closes
  await imgFrame.locator('.imageview img').click();
  await sleep(250);
  check(await page.locator('.lightbox').count() === 1, 'clicking an image opens the lightbox');
  await page.screenshot({ path: join(shots, '06f-lightbox.png') });
  const vp = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  await page.mouse.move(vp.w * 0.35, vp.h * 0.4);
  for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, -200); await sleep(40); }
  await sleep(200);
  const zoom = await page.locator('.lb-zoom').textContent();
  check(JSON.parse(await cli(env, 'view', '--json')).userViewingDesktop === 0, 'zooming the lightbox does not switch desktops');
  check(parseInt(zoom) > 150, `wheel zooms the lightbox (got ${zoom})`);
  await page.screenshot({ path: join(shots, '06g-lightbox-zoomed.png') });
  await page.keyboard.press('Escape');
  await sleep(150);
  check(await page.locator('.lightbox').count() === 0, 'Esc closes the lightbox');

  // Image grid: several images in one viewer, shown together; a tile opens that one alone.
  {
    const gid = (await cli(env, 'show', join(shots, '01-empty.png'), '--id', 'shots', '--caption', 'one')).split(' ')[0];
    for (const c of ['two', 'three']) await cli(env, 'show', join(shots, '06b-image.png'), '--id', gid, '--caption', c);
    await cli(env, 'app', gid, 'view', '--mode', 'grid');
    await sleep(900);
    const grid = appFrame(page, gid);
    const tiles = await grid.locator('.img-tile').count();
    check(tiles === 3, `image grid shows the recent images together (${tiles} tiles)`);
    await page.locator(`[data-window="${gid}"]`).screenshot({ path: join(shots, '06h-image-grid.png') });
    await cli(env, 'settings', 'set', 'app.image.gridSize', '2');
    await sleep(500);
    const capped = await grid.locator('.img-tile').count();
    check(capped === 2, `an app setting reaches its view: gridSize 2 shows ${capped} tiles`);
    await cli(env, 'settings', 'set', 'app.image.gridSize', '12');
    await sleep(500);
    await grid.locator('.img-tile').last().click();
    await sleep(400);
    const single = JSON.parse(await cli(env, 'state', gid)).state;
    check(single.view === 'single' && single.index === 0, 'clicking a grid tile opens that image alone');
    await cli(env, 'window', 'delete', gid);
  }

  // Reordering windows must not reload app frames (they'd flicker and lose scroll).
  {
    const mark = () => appFrame(page, 'terminal').locator('body').evaluate((b) => (b.dataset.mark ??= String(Math.random())));
    const before = await mark();
    await cli(env, 'window', 'move', 'terminal', '0');
    await sleep(400);
    await cli(env, 'window', 'move', 'terminal', '3');
    await sleep(400);
    check((await mark()) === before, 'reordering windows keeps app frames alive');
  }

  // Drag to the right edge, hold, drop → lands on desktop 2
  {
    const first = JSON.parse(await cli(env, 'view', '--json')).desktops[0].windows[0].id;
    const tb = await page.locator(`[data-window="${first}"] .titlebar`).boundingBox();
    const vw = await page.evaluate(() => window.innerWidth);
    await page.mouse.move(tb.x + tb.width / 2, tb.y + 18);
    await page.mouse.down();
    await page.mouse.move(vw - 8, 400, { steps: 10 });
    await sleep(900);
    await page.mouse.move(vw / 2, 400, { steps: 6 });
    await sleep(100);
    await page.screenshot({ path: join(shots, '06c-edge-drag.png') });
    await page.mouse.up();
    await sleep(700);
    const v2 = JSON.parse(await cli(env, 'view', '--json'));
    const onD2 = v2.desktops[1]?.windows.some((w) => w.id === first);
    check(onD2, `edge drag moves ${first} onto desktop 2`);
    await page.locator('.pager button').nth(0).click();
    await sleep(500);
  }

  // Informational: CDN scripts load inside the sandboxed html canvas (needs network).
  {
    const { writeFileSync } = await import('node:fs');
    const f = join(home, 'cdn.html');
    writeFileSync(f, `<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
      <body style="margin:0;background:#fff"><canvas id=c></canvas><script>
      document.title = typeof Chart;
      new Chart(document.getElementById('c'), { type: 'bar', data: { labels: ['Before','After'], datasets: [{ label: 'Renders', data: [50, 2] }] } });
      </script></body>`);
    await cli(env, 'show', f, '--title', 'Chart via CDN');
    await sleep(2500);
    const frame = page.frames().find((fr) => fr.url().startsWith('glass-html://html-2'));
    const t = frame ? await frame.title().catch(() => '?') : 'no frame';
    console.log(`  (info) Chart.js in sandbox: ${t === 'function' ? 'loaded' : 'not loaded: ' + t}`);
    await page.screenshot({ path: join(shots, '06d-cdn-chart.png') });
    await cli(env, 'window', 'close', 'html-2');
  }

  // Settings via dock
  await page.locator('.dock-item[title="Settings"]').click();
  await sleep(700);
  await page.screenshot({ path: join(shots, '07-settings.png') });
  await page.locator('.s-color').first().evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await sleep(150);
  await page.locator('[data-window="settings"]').screenshot({ path: join(shots, '07c-settings-look.png') });
  await page.locator('.s-num').first().evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await sleep(150);
  await page.locator('[data-window="settings"]').screenshot({ path: join(shots, '07e-settings-app-setting.png') });
  await page.locator('.settings').evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await sleep(150);
  await page.locator('[data-window="settings"]').screenshot({ path: join(shots, '07d-settings-apps.png') });
  check((await page.locator('.s-app-bad').count()) === 1 && (await page.locator('.s-app').count()) >= 9, 'settings lists every app, plus the custom one that failed');
  check((await page.locator('.settings').count()) === 1, 'settings opens from the dock');

  // Close a window via traffic light, reopen from dock
  await page.locator('[data-window="settings"] .light.close').click();
  await sleep(500);
  check(!(await cli(env, 'view')).match(/\bsettings\s+settings/), 'close button closes the window');

  // Dock order follows window order; auto-hide gives the space back and reveals at the bottom edge.
  {
    const winIds = JSON.parse(await cli(env, 'view', '--json')).desktops.flatMap((d) => d.windows.map((w) => w.id));
    const dockTitles = await page.locator('.dock-item').evaluateAll((els) => els.map((e) => e.getAttribute('title')));
    const winTitles = await Promise.all(winIds.map((id) => page.locator(`[data-window="${id}"] .wtitle`).innerText()));
    check(dockTitles.slice(0, winTitles.length).join('|') === winTitles.map((t) => t.replace(/^\S+\s*/, '')).join('|') ||
      dockTitles.slice(0, winTitles.length).every((t, i) => winTitles[i].endsWith(t)), `dock order matches window order (${dockTitles.slice(0, 4).join(', ')})`);
    const seps = await page.locator('.dock-sep.screen').count();
    const dimmed = await page.locator('.dock-item.off-screen').count();
    check(seps >= 1 && dimmed >= 1, `dock separates desktops (${seps} separators) and dims apps on other desktops (${dimmed})`);
    const stageH = () => page.locator('.stage').evaluate((e) => e.clientHeight);
    const before = await stageH();
    await cli(env, 'settings', 'set', 'dockAutoHide', 'true');
    await sleep(700);
    const after = await stageH();
    const hiddenTop = await page.locator('.dock').evaluate((e) => e.getBoundingClientRect().top);
    await page.screenshot({ path: join(shots, '07b-dock-hidden.png') });
    check(after > before && hiddenTop >= after + 40 - 2, `auto-hide gives the stage the dock's space (${before} → ${after}) and hides it`);
    const vp = page.viewportSize() ?? (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })));
    await page.mouse.move(vp.width / 2, vp.height - 12);
    await sleep(500);
    const shownBottom = await page.locator('.dock').evaluate((e) => e.getBoundingClientRect().bottom);
    await page.screenshot({ path: join(shots, '07c-dock-revealed.png') });
    check(shownBottom <= vp.height, 'hovering the bottom edge reveals the dock');
    // Focus landing on a hidden dock button must not scroll the whole glass up.
    await page.mouse.move(vp.width / 2, vp.height / 2);
    await sleep(700);
    await page.locator('.dock-item').first().evaluate((b) => b.focus());
    await sleep(300);
    const shift = await page.evaluate(() => ({ top: document.querySelector('.topbar').getBoundingClientRect().top, scroll: document.scrollingElement.scrollTop + document.querySelector('.glass').scrollTop }));
    check(shift.top === 0 && shift.scroll === 0, `a focused hidden dock doesn't push the glass up (topbar at ${shift.top})`);
    await page.mouse.move(vp.width / 2, vp.height / 2);
    await cli(env, 'settings', 'set', 'dockAutoHide', 'false');
    await sleep(500);
  }

  // Streaming + working state
  await hook(env, { hook_event_name: 'UserPromptSubmit', prompt: 'Show me the final diff.' });
  await hook(env, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm run build' }, tool_use_id: 'live1' });
  await hook(env, { hook_event_name: 'MessageDisplay', message_id: 'live', turn_id: 't2', index: 0, final: false, delta: 'Building now, then I will' });
  await sleep(500);
  await page.screenshot({ path: join(shots, '08-working.png') });
  check((await page.locator('.presence-working').count()) === 1, 'presence shows working');

  // Waiting on the user: permission prompt (pill + terminal lock), then a question (read-only card).
  await cli(env, 'window', 'move', 'terminal', '0');
  await hook(env, { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm run build' }, tool_use_id: 'live1' });
  await sleep(500);
  await page.screenshot({ path: join(shots, '08b-waiting-permission.png') });
  check((await page.locator('.presence-waiting').count()) === 1 && (await appFrame(page, 'terminal').locator('.t-locked').count()) === 1, 'permission prompt shows waiting pill and locks the terminal row');
  {
    const gap = await appFrame(page, 'terminal').locator('.t-scroll').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
    check(gap < 5, `terminal stays scrolled to the newest entry (gap ${gap}px)`);
  }
  check((await page.locator('.glass.waiting-glow').count()) === 1, 'waiting glow is on by default');
  await hook(env, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm run build' }, tool_use_id: 'live1', tool_response: { stdout: 'built' } });
  await hook(env, {
    hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_use_id: 'ask1',
    tool_input: { questions: [{ header: 'Deploy', question: 'Ship the build to staging now?', multiSelect: false, options: [
      { label: 'Yes, ship it', description: 'Deploys the build you just made to staging' },
      { label: 'Not yet', description: 'Keep working locally' }] }] },
  });
  await sleep(500);
  await page.screenshot({ path: join(shots, '08c-waiting-question.png') });
  const card = page.locator('.question-card');
  check((await card.count()) === 1 && (await card.locator('button').count()) === 0 && (await card.innerText()).includes('Answer in Claude Code'), 'question card is shown, read-only');
  await hook(env, { hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_use_id: 'ask1', tool_input: {}, tool_response: {} });
  await sleep(400);
  check((await page.locator('.question-card').count()) === 0 && (await page.locator('.presence-waiting').count()) === 0, 'answering clears the waiting state');

  // Browser app: screencast a real headless Chromium over CDP, then a pushed screenshot.
  {
    const port = 9400 + Math.floor(Math.random() * 400);
    const browser = await chromium.launch({ args: [`--remote-debugging-port=${port}`] });
    try {
      const bp = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await bp.setContent(`<title>Checkout</title><body style="margin:0;font:28px system-ui;background:linear-gradient(135deg,#fde68a,#f9a8d4);height:100vh;display:grid;place-items:center">
        <div style="background:#fff;padding:40px 56px;border-radius:18px;box-shadow:0 20px 50px #0003"><h1 style="margin:0 0 12px">Checkout</h1>
        <p style="margin:0;color:#555">Claude is filling in this form in Playwright.</p></div></body>`);
      await cli(env, 'app', 'browser', 'attach', '--cdp', String(port));
      await appFrame(page, 'browser').locator('.browserview .b-stage img').waitFor({ timeout: 8000 }).catch(() => {});
      await sleep(1200);
      await page.screenshot({ path: join(shots, '09-browser-live.png') });
      const st = JSON.parse(await cli(env, 'state', 'browser')).state;
      check(st.status === 'live' && st.title === 'Checkout', `browser streams a CDP page (status ${st.status}, title ${st.title})`);
      const frameOk = await appFrame(page, 'browser').locator('.browserview .b-stage img').evaluate((img) => img.complete && img.naturalWidth > 0).catch(() => false);
      check(frameOk, 'browser view shows screencast frames');
    } finally {
      await browser.close();
    }
    await sleep(1600);
    const gone = JSON.parse(await cli(env, 'state', 'browser')).state;
    check(gone.status === 'waiting', `browser goes to waiting when Chromium quits (got ${gone.status})`);
    await cli(env, 'app', 'browser', 'frame', '--file', join(shots, '02-seeded.png'), '--url', 'https://example.com/firefox');
    await sleep(500);
    await page.screenshot({ path: join(shots, '09b-browser-pushed.png') });
    const pushed = await appFrame(page, 'browser').locator('.browserview .b-stage img').evaluate((img) => img.complete && img.naturalWidth > 0).catch(() => false);
    check(pushed, 'browser view shows a pushed screenshot');
  }

  // Web research: WebSearch shows the query then results; WebFetch renders the page offscreen.
  {
    const LONG = `<title>y:0</title><body style="margin:0;font:18px system-ui;background:#fff;color:#222;padding:30px 40px">
      <script>addEventListener('scroll', () => { document.title = 'y:' + Math.round(scrollY); });</script>
      <h1>Long article</h1><p><a href="/elsewhere" style="font-size:28px">A link somewhere else</a></p>
      ${Array.from({ length: 60 }, (_, i) => `<p>Filler paragraph ${i} about nothing in particular.</p>`).join('')}
      <p>The screencast frame acknowledgement keeps frames flowing.</p>
      ${Array.from({ length: 30 }, (_, i) => `<p>More filler ${i}.</p>`).join('')}</body>`;
    const srv = createServer((q, r) => { r.setHeader('content-type', 'text/html; charset=utf-8');
      if (q.url === '/long') return r.end(LONG);
      if (q.url === '/elsewhere') return r.end('<title>Elsewhere</title><h1 style="font:40px system-ui">Somewhere else</h1>');
      r.end(`<title>Screencast docs</title>
      <body style="margin:0;font:18px system-ui;background:#fff;color:#222"><header style="background:#1a73e8;color:#fff;padding:22px 40px;font-size:26px">Page domain</header>
      <main style="padding:30px 40px;max-width:780px"><h2>Page.startScreencast</h2><p>Starts sending each frame using the <code>screencastFrame</code> event.</p>
      <h3>Parameters</h3><ul><li><b>format</b> — jpeg or png</li><li><b>quality</b> — 0..100</li><li><b>maxWidth</b>, <b>maxHeight</b></li><li><b>everyNthFrame</b></li></ul></main></body>`); });
    await new Promise((res) => srv.listen(0, '127.0.0.1', res));
    const url = `http://127.0.0.1:${srv.address().port}/docs/page`;
    try {
      await hook(env, { hook_event_name: 'PreToolUse', tool_name: 'WebSearch', tool_use_id: 'ws1', tool_input: { query: 'CDP screencast parameters' } });
      await sleep(400);
      check((await appFrame(page, 'browser').locator('.browserview .b-meta').innerText()).includes('searching'), 'web search shows while searching');
      await hook(env, { hook_event_name: 'PostToolUse', tool_name: 'WebSearch', tool_use_id: 'ws1', tool_input: { query: 'CDP screencast parameters' },
        tool_response: { query: 'CDP screencast parameters', results: [{ tool_use_id: 'x', content: [
          { title: 'Chrome DevTools Protocol - Page domain', url: 'https://chromedevtools.github.io/devtools-protocol/tot/Page/' },
          { title: 'How to do video recording on headless chrome', url: 'https://medium.com/@anchen.li/how-to-do-video-recording' },
          { title: 'puppeteer screen recorder', url: 'https://github.com/axelboberg/puppeteer-screen-recorder' }] }, 'Summary text'] } });
      await sleep(500);
      await page.screenshot({ path: join(shots, '09c-web-search.png') });
      check((await appFrame(page, 'browser').locator('.b-results li').count()) === 3, 'web search results are listed');
      await hook(env, { hook_event_name: 'PreToolUse', tool_name: 'WebFetch', tool_use_id: 'wf1', tool_input: { url, prompt: 'params?' } });
      await appFrame(page, 'browser').locator('.browserview .b-stage img').waitFor({ timeout: 8000 }).catch(() => {});
      await sleep(800);
      await page.screenshot({ path: join(shots, '09d-web-page.png') });
      const st = JSON.parse(await cli(env, 'state', 'browser')).state;
      const cur = st.history[st.history.length - 1];
      check(st.view === 'web' && cur.title === 'Screencast docs', `fetched page renders in the browser (title ${cur?.title})`);
      // History: back shows the search again, the list lets you jump anywhere.
      await appFrame(page, 'browser').locator('.browserview .b-nav button[aria-label="Back"]').click();
      await sleep(300);
      check((await appFrame(page, 'browser').locator('.b-results li').count()) === 3, 'back returns to the search results');
      await appFrame(page, 'browser').locator('.browserview .b-hist-btn').click();
      await sleep(250);
      await page.screenshot({ path: join(shots, '09e-web-history.png') });
      check((await appFrame(page, 'browser').locator('.b-hist li').count()) === 2, 'history list shows every search and page');
      await appFrame(page, 'browser').locator('.b-hist li').first().click();
      await appFrame(page, 'browser').locator('.browserview .b-stage img').waitFor({ timeout: 5000 }).catch(() => {});
      check((await appFrame(page, 'browser').locator('.b-results').count()) === 0 && (await appFrame(page, 'browser').locator('.browserview .b-stage img').count()) === 1, 'picking the page from history shows it again');

      // Highlight: Claude points at a passage; the page scrolls to it.
      const longUrl = `http://127.0.0.1:${srv.address().port}/long`;
      await hook(env, { hook_event_name: 'PreToolUse', tool_name: 'WebFetch', tool_use_id: 'wf2', tool_input: { url: longUrl, prompt: 'x' } });
      await sleep(1500);
      await cli(env, 'app', 'browser', 'highlight', '--text', 'frame acknowledgement keeps');
      await sleep(1500);
      await page.screenshot({ path: join(shots, '09f-web-highlight.png') });
      let b = JSON.parse(await cli(env, 'state', 'browser')).state;
      let entry = b.history[b.history.length - 1];
      check(entry.found === 1 && /^y:[1-9]/.test(entry.title), `highlight finds and scrolls to the passage (found ${entry.found}, ${entry.title})`);
      // Scroll the glass's copy with the wheel, then click a link and come back.
      const live = appFrame(page, 'browser').locator('.b-live');
      const box = await live.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      const yBefore = Number(entry.title.slice(2));
      await page.mouse.wheel(0, -600);
      await sleep(900);
      b = JSON.parse(await cli(env, 'state', 'browser')).state;
      entry = b.history[b.history.length - 1];
      const yAfter = Number(entry.title.slice(2));
      check(yAfter < yBefore, `wheel scrolls the page copy (y ${yBefore} → ${yAfter})`);
      for (let i = 0; i < 12; i++) {
        await page.mouse.wheel(0, -1500);
        await sleep(250);
        const st2 = JSON.parse(await cli(env, 'state', 'browser')).state;
        if (st2.history[st2.history.length - 1].title === 'y:0') break;
      }
      await sleep(500);
      const lb = await live.boundingBox();
      // The link sits near the top of the page: ~ (60px, 110px) of a 1024px-wide page.
      await page.mouse.click(lb.x + lb.width * (130 / 1024), lb.y + lb.width * (112 / 1024));
      await sleep(1200);
      b = JSON.parse(await cli(env, 'state', 'browser')).state;
      check(b.away && b.away.endsWith('/elsewhere'), `clicking a link browses the glass's copy (away: ${b.away})`);
      await page.screenshot({ path: join(shots, '09g-web-browsing.png') });
      await appFrame(page, 'browser').locator('.b-note button').click();
      await sleep(1200);
      b = JSON.parse(await cli(env, 'state', 'browser')).state;
      check(b.away === null, "'Back to Claude's page' returns");
    } finally {
      srv.close();
    }
  }

  // Custom app (mod): sandboxed frame view, props over the bridge, view commands, CLI commands.
  {
    await cli(env, 'window', 'open', 'tool-count');
    await cli(env, 'app', 'tool-count', 'note', '--text', 'Hello from a mod');
    await sleep(700);
    const frame = page.frameLocator('[data-window="tool-count"] iframe.appframe');
    const note = await frame.locator('#note').textContent({ timeout: 4000 }).catch(() => '');
    check(note === 'Hello from a mod', `mod view renders its state (note: ${note})`);
    check((await frame.locator('.row').count()) >= 3, 'mod filled itself from hooks (onHook)');
    await frame.locator('button[data-by="name"]').click();
    await sleep(300);
    const st = JSON.parse(await cli(env, 'state', 'tool-count')).state;
    check(st.sort === 'name', 'mod view ran its view command');
    await page.screenshot({ path: join(shots, '10-mod.png') });
    const guide = JSON.parse(await cli(env, 'catalog', '--json')).find((a) => a.type === 'tool-count');
    check(guide?.source === 'user', 'mod is in the catalog');
    const iconOk = await page.locator('.dock-item[data-dock-id="tool-count"] .tile img.app-icon').evaluate((img) => img.complete && img.naturalWidth > 0).catch(() => false);
    check(iconOk, 'a custom app shows its own image icon in the dock');
  }

  // Nested view (global setting): one spiral page, no layout button.
  {
    await cli(env, 'settings', 'set', 'nestedView', 'true');
    await sleep(700);
    await page.screenshot({ path: join(shots, '11-nested-view.png') });
    check((await page.locator('.light.layout').count()) === 0 && (await page.locator('.pager button').count()) === 1, 'nested view: one page, layout buttons hidden');
    await cli(env, 'settings', 'set', 'nestedView', 'false');
    await sleep(500);
    check((await page.locator('.light.layout').count()) > 0, 'nested view off: layout buttons back');
  }

  // History mode (experiment): no move-to-front button, no drag reorder.
  {
    await cli(env, 'settings', 'set', 'session.windowMode', 'history');
    await sleep(500);
    check((await page.locator('.light.front').count()) === 0, 'history mode hides move-to-front');
    await cli(env, 'settings', 'set', 'session.windowMode', 'live');
    await sleep(300);
  }

  // Virtualization: windows on far desktops don't mount their app views until you get near.
  {
    const made = [];
    for (let i = 0; i < 12; i++) made.push((await cli(env, 'new', 'markdown', '--title', `Far ${i}`)).trim());
    await sleep(800);
    const total = await page.locator('.window').count();
    const mounted = await page.locator('.window iframe.appframe').count();
    const pagesN = await page.locator('.pager button').count();
    check(pagesN >= 4 && mounted < total, `far windows are virtualized (${mounted} of ${total} views mounted, ${pagesN} desktops)`);
    for (let i = 0; i < pagesN; i++) { await page.keyboard.press('Meta+ArrowRight'); await sleep(250); }
    await sleep(600);
    const last = JSON.parse(await cli(env, 'view', '--json')).desktops.at(-1).windows[0].id;
    check((await page.locator(`[data-window="${last}"] iframe.appframe`).count()) === 1, 'a far window mounts when you scroll to it');
    for (let i = 0; i < pagesN; i++) await page.keyboard.press('Meta+ArrowLeft');
    for (const id of made) await cli(env, 'window', 'close', id);
    await sleep(400);
  }

  // App permissions: granted only as declared.
  {
    await cli(env, 'new', 'perm-demo');
    await cli(env, 'new', 'noperm-demo');
    await sleep(1500);
    const read = async (id) => (await appFrame(page, id).locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    const withP = await read('perm-demo'), without = await read('noperm-demo');
    check(withP === 'net:hello store:1 mic:granted', `an app gets the network, storage and microphone it declared (${withP})`);
    check(without.startsWith('net:blocked store:blocked mic:') && !without.endsWith('granted'), `an app without permissions gets none (${without})`);
    // Reopening keeps storage (count goes up); Settings → Reset data clears it (back to 1).
    await cli(env, 'window', 'close', 'perm-demo'); await sleep(200);
    await cli(env, 'window', 'open', 'perm-demo'); await sleep(1200);
    const again = await read('perm-demo');
    await cli(env, 'window', 'open', 'settings'); await sleep(500);
    await page.locator('.s-app', { hasText: 'perm-demo' }).locator('.s-reset').click(); await sleep(500);
    await cli(env, 'window', 'close', 'perm-demo'); await sleep(200);
    await cli(env, 'window', 'open', 'perm-demo'); await sleep(1200);
    const reset = await read('perm-demo');
    check(again.includes('store:2') && reset.includes('store:1'), `Reset data clears an app's storage (${again.split(' ')[1]} → ${reset.split(' ')[1]})`);
    await cli(env, 'window', 'close', 'settings');
    await cli(env, 'window', 'close', 'perm-demo');
    await cli(env, 'window', 'close', 'noperm-demo');
    permSrv.close();
    // The blocked demo's CSP/permission-policy console errors are the point of the test, not failures.
    for (let i = errors.length - 1; i >= 0; i--) if (errors[i].includes(permOrigin) || /Permissions policy violation: microphone/.test(errors[i])) errors.splice(i, 1);
  }

  // Edge sidebars ("pin"): ⌘-drag a window to an edge to pin it; a plain drag only reorders.
  {
    await sleep(800); // let window moves finish animating before measuring a title bar
    const first = JSON.parse(await cli(env, 'view', '--json')).desktops[0].windows[0].id;
    const tb = await page.locator(`[data-window="${first}"] .titlebar`).first().boundingBox();
    const stage = await page.locator('.stage').boundingBox();
    await page.mouse.move(tb.x + tb.width / 2, tb.y + 18);
    await page.mouse.down();
    await page.mouse.move(stage.x + stage.width - 6, stage.y + stage.height / 2, { steps: 10 });
    await sleep(150);
    check((await page.locator('.tuck-zone').count()) === 0, 'a plain drag to an edge shows no pin strips');
    await page.keyboard.down('Meta');
    await page.mouse.move(stage.x + stage.width - 8, stage.y + stage.height / 2 + 4);
    await sleep(150);
    check((await page.locator('.tuck-zone.right.on').count()) === 1, 'holding ⌘ shows the pin strips and lights the one under the pointer');
    await page.mouse.up();
    await page.keyboard.up('Meta');
    await sleep(500);
    let v = JSON.parse(await cli(env, 'view', '--json'));
    check(v.tucked?.right?.[0]?.id === first, `⌘-dropping on the strip pins the window right (${JSON.stringify(v.tucked)})`);
    await cli(env, 'window', 'pin', 'terminal', 'right');
    await sleep(400);
    // Hover anywhere along the edge (not just the tab) to reveal it.
    await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2, { steps: 4 });
    await page.mouse.move(stage.x + stage.width - 4, stage.y + stage.height * 0.85, { steps: 4 });
    await sleep(400);
    check((await page.locator('.edge-cap.right.near').count()) === 1 && (await page.locator('.edge-panel.right.open').count()) === 0,
      'hovering anywhere along the edge starts pulling the sidebar out (without opening it)');
    await page.mouse.down(); await page.mouse.up(); // click the edge
    await sleep(900); // stays open after sliding in under the pointer
    check((await page.locator('.edge-panel.right.open .window').count()) === 2, 'clicking the edge opens the sidebar; two windows split it');
    await page.screenshot({ path: join(shots, '12-edge-tuck.png') });
    // Keep it open: it stays when the pointer leaves, and the layout makes room for it.
    await page.locator('.edge-cap.right.open').click();
    await page.mouse.move(stage.x + stage.width / 3, stage.y + stage.height / 2, { steps: 4 });
    await sleep(700);
    const panelLeft = (await page.locator('.edge-panel.right').boundingBox()).x;
    const rightmost = await page.locator('.strip > .window').evaluateAll((els, vw) => Math.max(...els.map((e) => e.getBoundingClientRect()).filter((r) => r.left >= 0 && r.right <= vw + 1).map((r) => r.right)), (await page.evaluate(() => innerWidth)));
    check((await page.locator('.edge-panel.right.open.kept').count()) === 1 && rightmost <= panelLeft, `a kept-open sidebar stays and the layout makes room (windows end at ${Math.round(rightmost)}, sidebar starts ${Math.round(panelLeft)})`);
    // Resize it from its inner edge.
    const handle = await page.locator('.edge-resize.right').boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + 40);
    await page.mouse.down();
    await page.mouse.move(handle.x - 120, handle.y + 40, { steps: 6 });
    await page.mouse.up();
    await sleep(500);
    const wider = (await page.locator('.edge-panel.right').boundingBox()).width;
    const st = JSON.parse(await cli(env, 'state', '--json'));
    check(Math.abs(wider - st.tuckSize.right) < 2 && st.tuckSize.right > 400, `dragging a kept sidebar's inner edge resizes it (${Math.round(wider)}px, saved ${st.tuckSize.right})`);
    await page.screenshot({ path: join(shots, '12b-edge-kept.png') });
    // A kept-open sidebar takes a plain drop anywhere over it (no ⌘).
    const other = JSON.parse(await cli(env, 'view', '--json')).desktops[0].windows[0].id;
    const tb2 = await page.locator(`.strip [data-window="${other}"] .titlebar`).first().boundingBox();
    await page.mouse.move(tb2.x + tb2.width / 2, tb2.y + 18);
    await page.mouse.down();
    const pb = await page.locator('.edge-panel.right').boundingBox();
    await page.mouse.move(pb.x + pb.width / 2, pb.y + pb.height / 2, { steps: 8 });
    await sleep(150);
    check((await page.locator('.edge-panel.right.drop-on').count()) === 1, 'dragging over a kept-open sidebar lights it up as the target');
    await page.mouse.up();
    await sleep(500);
    v = JSON.parse(await cli(env, 'view', '--json'));
    check(v.tucked?.right?.some((w) => w.id === other), `dropping over a kept-open sidebar pins the window there (${JSON.stringify(v.tucked?.right?.map((w) => w.id))})`);
    await page.locator('.edge-cap.right.open').click();
    for (const w of v.tucked.right) await cli(env, 'window', 'unpin', w.id);
    await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2);
    await sleep(600);
    v = JSON.parse(await cli(env, 'view', '--json'));
    check(!v.tucked && v.desktops[0].windows.some((w) => w.id === first), 'unpin puts windows back in the layout');
    // Mouse only: drop on the pin target mid-edge (no ⌘) to pin; top/bottom sidebars fit between sides.
    await sleep(500);
    const w1 = JSON.parse(await cli(env, 'view', '--json')).desktops[0].windows[0].id;
    const t1 = await page.locator(`.strip [data-window="${w1}"] .titlebar`).first().boundingBox();
    await page.mouse.move(t1.x + t1.width / 2, t1.y + 18);
    await page.mouse.down();
    await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2, { steps: 4 });
    const tgt = await page.locator('.pin-target.left').boundingBox();
    await page.mouse.move(tgt.x + tgt.width / 2, tgt.y + tgt.height / 2, { steps: 6 });
    await sleep(150);
    const lit = await page.locator('.pin-target.left.on').count();
    await page.mouse.up();
    await sleep(500);
    v = JSON.parse(await cli(env, 'view', '--json'));
    check(lit === 1 && v.tucked?.left?.[0]?.id === w1, `dropping on a pin target pins the window (${JSON.stringify(v.tucked)})`);
    const w2 = v.desktops[0].windows[0].id; // a different window for the bottom sidebar
    await cli(env, 'window', 'pin', w2, 'bottom');
    await sleep(300);
    for (const e of ['left', 'bottom']) {
      await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2, { steps: 3 });
      // Click the edge to open it.
      await page.mouse.move(e === 'left' ? stage.x + 4 : stage.x + stage.width * 0.15, e === 'left' ? stage.y + stage.height * 0.3 : stage.y + stage.height - 4, { steps: 3 });
      await page.mouse.down(); await page.mouse.up();
      await sleep(500);
      await page.locator(`.edge-cap.${e}.open`).click();
      await sleep(400);
    }
    await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 3, { steps: 3 });
    await sleep(600);
    const L = await page.locator('.edge-panel.left').boundingBox(), B = await page.locator('.edge-panel.bottom').boundingBox();
    check(B.x >= L.x + L.width, `side sidebars win: the bottom one fits beside the left one (left ends ${Math.round(L.x + L.width)}, bottom starts ${Math.round(B.x)})`);
    await page.screenshot({ path: join(shots, '12c-sidebars.png') });
    for (const e of ['left', 'bottom']) await page.locator(`.edge-cap.${e}.open`).click();
    await cli(env, 'window', 'unpin', w1);
    await cli(env, 'window', 'unpin', w2);
    await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2);
    await sleep(500);

    // Inside a sidebar: drag to reorder, drag out onto the layout to unpin. Placeholders show where.
    const lay = JSON.parse(await cli(env, 'view', '--json')).desktops[0].windows.map((w) => w.id);
    await cli(env, 'window', 'pin', lay[0], 'right');
    await cli(env, 'window', 'pin', lay[1], 'right');
    await cli(env, 'settings', 'set', 'dockAutoHide', 'false');
    await sleep(500);
    await page.screenshot({ path: join(shots, '12d-pull.png') }); // the drawer pull on the right edge
    await page.mouse.move(stage.x + stage.width - 4, stage.y + stage.height * 0.2, { steps: 4 });
    await sleep(600);
    await page.screenshot({ path: join(shots, '12e-pulled.png') }); // hovering: the pull starts coming out
    await page.mouse.down(); await page.mouse.up();
    await sleep(600);
    await page.screenshot({ path: join(shots, '12g-open.png') }); // open: the rail backs the drawer
    await page.locator('.edge-cap.right.open').click();
    await sleep(500);
    const topWin = await page.locator(`.edge-panel.right [data-window="${lay[0]}"] .titlebar`).boundingBox();
    const botWin = await page.locator(`.edge-panel.right [data-window="${lay[1]}"]`).boundingBox();
    await page.mouse.move(topWin.x + 60, topWin.y + 18);
    await page.mouse.down();
    await page.mouse.move(botWin.x + botWin.width / 2, botWin.y + botWin.height * 0.85, { steps: 8 });
    await sleep(200);
    const panelGhost = await page.locator('.edge-panel.right .drop-ghost').count();
    await page.mouse.up();
    await sleep(500);
    let st2 = JSON.parse(await cli(env, 'state', '--json'));
    check(panelGhost === 1 && st2.tucked.right.join() === [lay[1], lay[0]].join(), `dragging within a sidebar reorders it, with a placeholder (${st2.tucked.right.join(', ')})`);
    const moving = await page.locator(`.edge-panel.right [data-window="${lay[0]}"] .titlebar`).boundingBox();
    const into = JSON.parse(await cli(env, 'view', '--json')).desktops[0].windows[0].id;
    const slotBox = await page.locator(`.strip [data-window="${into}"]`).boundingBox();
    await page.mouse.move(moving.x + 60, moving.y + 18);
    await page.mouse.down();
    await page.mouse.move(slotBox.x + slotBox.width / 2, slotBox.y + slotBox.height / 2, { steps: 10 });
    await sleep(200);
    const layoutGhost = await page.locator('.strip .drop-ghost').count();
    await page.screenshot({ path: join(shots, '12f-drag-out.png') });
    await page.mouse.up();
    await sleep(500);
    st2 = JSON.parse(await cli(env, 'state', '--json'));
    check(layoutGhost === 1 && !st2.tucked.right.includes(lay[0]) && st2.order[0] === lay[0], `dragging a window out of a sidebar unpins it into that slot, with a placeholder (order starts ${st2.order[0]})`);
    await page.locator('.edge-cap.right.open').click();
    await cli(env, 'window', 'unpin', lay[1]);
    // With the dock on auto-hide, the bottom edge away from the dock still reveals the bottom sidebar.
    await cli(env, 'settings', 'set', 'dockAutoHide', 'true');
    await cli(env, 'window', 'pin', 'terminal', 'bottom');
    await sleep(500);
    const full = await page.locator('.stage').boundingBox(); // auto-hide gives the stage the dock's space
    await page.mouse.move(full.x + full.width / 2, full.y + full.height / 2, { steps: 3 });
    // The bottom pull's capsule sits centered, above the dock's trigger; the rest of the edge raises
    // the dock, and the capsule fades out while the dock is up.
    const cap = await page.locator('.edge-cap.bottom').boundingBox();
    const onTop = await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('.edge-cap.bottom'), [cap.x + cap.width / 2, cap.y + cap.height - 4]);
    check(onTop, 'with an auto-hidden dock, the bottom pull sits above the dock trigger');
    await page.mouse.move(cap.x - 120, full.y + full.height - 3, { steps: 3 });
    await sleep(500);
    const capGone = await page.locator('.edge-cap.bottom').evaluate((e) => getComputedStyle(e).opacity === '0');
    check(capGone, 'with the dock raised, the bottom pull steps aside');
    await page.mouse.move(full.x + full.width / 2, full.y + full.height / 2, { steps: 3 });
    await sleep(700);
    await page.mouse.move(cap.x + cap.width / 2, cap.y + cap.height / 2, { steps: 4 });
    await sleep(300);
    await page.mouse.down(); await page.mouse.up();
    await sleep(600);
    check((await page.locator('.edge-panel.bottom.open').count()) === 1, 'with an auto-hidden dock, clicking the bottom pull opens the bottom sidebar');
    await page.screenshot({ path: join(shots, '12h-bottom.png') });
    await cli(env, 'window', 'unpin', 'terminal');
    await cli(env, 'settings', 'set', 'dockAutoHide', 'false');
    await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2);
    await sleep(400);
  }

  // Dock: drag an icon along the dock to reorder windows, or onto an edge to tuck it.
  {
    await sleep(500);
    const ids = await page.locator('.dock-item[data-dock-id]').evaluateAll((els) => els.map((e) => e.dataset.dockId));
    const order = JSON.parse(await cli(env, 'view', '--json')).desktops.flatMap((d) => d.windows.map((w) => w.id));
    const mover = order[2], anchor = order[0];
    const from = await page.locator(`.dock-item[data-dock-id="${mover}"] .tile`).boundingBox();
    const to = await page.locator(`.dock-item[data-dock-id="${anchor}"] .tile`).boundingBox();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + 4, to.y + to.height / 2, { steps: 8 });
    await sleep(150);
    await page.mouse.up();
    await sleep(500);
    const after = JSON.parse(await cli(env, 'view', '--json')).desktops[0].windows[0].id;
    check(after === mover, `dragging a dock icon before the first reorders windows (${mover} → first, got ${after})`);
    const stage = await page.locator('.stage').boundingBox();
    const from2 = await page.locator(`.dock-item[data-dock-id="${mover}"] .tile`).boundingBox();
    await page.mouse.move(from2.x + from2.width / 2, from2.y + from2.height / 2);
    await page.mouse.down();
    await page.mouse.move(stage.x + 6, stage.y + stage.height / 2, { steps: 10 });
    await sleep(150);
    await page.mouse.up();
    await sleep(500);
    const v = JSON.parse(await cli(env, 'view', '--json'));
    check(v.tucked?.left?.[0]?.id === mover, `dragging a dock icon onto an edge tucks it (${JSON.stringify(v.tucked)})`);
    await cli(env, 'window', 'untuck', mover);
    // Crowd the dock: icons shrink to fit, and the dock never runs off the window.
    const made = [];
    for (let i = 0; i < 16; i++) made.push((await cli(env, 'new', 'markdown', '--title', `Crowd ${i}`, '--no-open')).trim());
    await sleep(500);
    const fit = await page.evaluate(() => ({ dock: document.querySelector('.dock').getBoundingClientRect().width, win: innerWidth, tile: document.querySelector('.dock-item .tile').getBoundingClientRect().width }));
    check(fit.dock <= fit.win && fit.tile < 38, `a crowded dock shrinks its icons and stays on screen (${Math.round(fit.tile)}px icons, dock ${Math.round(fit.dock)} of ${fit.win})`);
    await page.screenshot({ path: join(shots, '13-dock.png') });
    for (const id of made) await cli(env, 'window', 'close', id);
  }

  // Background light: Claude's signal recolors the wallpaper blobs, easing over; reset restores.
  {
    const blobColor = () => page.evaluate(() => getComputedStyle(document.querySelector('.bokeh')).getPropertyValue('--bokeh').trim());
    const before = await blobColor();
    await cli(env, 'background', '--colors', '#c0392b,#8e2a1e');
    await sleep(2000);
    const signal = await blobColor();
    check(signal === 'rgb(192, 57, 43)', `Claude's background signal recolors the wallpaper light (${before} → ${signal})`);
    await page.screenshot({ path: join(shots, '14-signal.png') });
    await cli(env, 'background', 'reset');
    await sleep(2000);
    check((await blobColor()) === before, 'background reset brings back the usual light');
    // State colors (on by default): done → green; a new prompt → back to the user's own light.
    await hook(env, { hook_event_name: 'Stop' });
    await sleep(2000);
    const done = await blobColor();
    check(done === 'rgb(39, 174, 96)', `state colors: the light turns green when Claude is done (${done})`);
    await page.screenshot({ path: join(shots, '14b-state-idle.png') });
    await hook(env, { hook_event_name: 'UserPromptSubmit', prompt: 'next' });
    await sleep(2000);
    const working = await blobColor();
    check(working !== done, `state colors: working goes back to the user's own light (${working})`);
  }

  // macOS fullscreen hides the traffic lights: the top bar drops their inset.
  {
    // The glass window, not one of the hidden windows that render fetched pages.
    const setFull = (on) => app.evaluate(({ BrowserWindow }, on) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('renderer/index.html')).setFullScreen(on), on);
    await setFull(true);
    await sleep(1500);
    const pad = await page.evaluate(() => getComputedStyle(document.querySelector('.topbar')).paddingLeft);
    check(pad === '16px', `in fullscreen the top bar drops the traffic-light inset (padding ${pad})`);
    await page.screenshot({ path: join(shots, '15-fullscreen.png') });
    await setFull(false);
    await sleep(1500);
    const back = await page.evaluate(() => getComputedStyle(document.querySelector('.topbar')).paddingLeft);
    check(back === '84px', `leaving fullscreen brings the inset back (padding ${back})`);
  }

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
