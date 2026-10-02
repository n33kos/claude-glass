// Visual E2E: launch Electron against a temp home, seed content, capture screenshots.
// Screenshots land in test/screenshots/ — LOOK at them after UI changes.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, _electron as electron } from 'playwright';
import { cli, event, project, run, seed } from './seed.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const shots = join(root, 'test/screenshots');
mkdirSync(shots, { recursive: true });
const home = mkdtempSync(join(tmpdir(), 'cc-e2e-home-'));
const runtime = mkdtempSync('/tmp/cc-e2e-rt-');
// Example mods (auto-open off so they don't reshuffle the layout checks; opened near the end).
cpSync(join(root, 'test/fixtures/apps'), join(home, 'apps'), { recursive: true });
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
    // The light is one small canvas (a quarter size): its pixels change as it drifts.
    const pixels = () => page.locator('.wallpaper canvas.wallpaper-light').evaluate((c) => c.toDataURL());
    const size = await page.locator('.wallpaper canvas.wallpaper-light').evaluate((c) => [c.width, c.clientWidth]);
    const a = await pixels();
    await sleep(1500);
    const b = await pixels();
    check(a !== b && size[0] <= size[1] / 3, `background light drifts on a small canvas (${size[0]}px drawn for ${size[1]}px shown)`);
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

  // Markdown links: another markdown file opens in the viewer (Back returns), #section scrolls, a web
  // link doesn't navigate the frame.
  {
    const dir = mkdtempSync(join(tmpdir(), 'cg-md-'));
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'index.md'), '# Index\n\nSee [the guide](docs/guide.md#setup), or [the web](https://example.com).\n');
    writeFileSync(join(dir, 'docs/guide.md'), `# Guide\n\n${'Filler paragraph.\n\n'.repeat(40)}## Setup\n\nRun the thing. Back to [the index](../index.md).\n`);
    await cli(env, 'show', join(dir, 'index.md'), '--id', 'docs');
    await sleep(700);
    const md = appFrame(page, 'docs');
    // (Not clicking "the web": it would open the user's real browser.)
    await md.locator('a', { hasText: 'the guide' }).click();
    await md.locator('h2#setup').waitFor({ timeout: 3000 });
    const inView = await md.locator('h2#setup').evaluate((h) => { const r = h.getBoundingClientRect(); return r.top >= -2 && r.top < innerHeight; });
    check((await md.locator('.md-nav').count()) === 1 && inView, 'a markdown link opens the linked file in the viewer, scrolled to its #section');
    await page.locator('[data-window="docs"]').screenshot({ path: join(shots, '06i-markdown-link.png') });
    await md.locator('.md-nav button', { hasText: 'Back' }).click();
    await sleep(200);
    check((await md.locator('h1', { hasText: 'Index' }).count()) === 1 && (await md.locator('.md-nav').count()) === 0, 'Back returns to what Claude showed');
    await cli(env, 'window', 'delete', 'docs');
  }

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

  // One Images window: `show` without an id goes to it; its Project tab lists the project's images.
  {
    const a = await cli(env, 'show', join(shots, '01-empty.png'));
    const b = await cli(env, 'show', join(shots, '06b-image.png'));
    check(a.startsWith('images ') && b.startsWith('images '), `images all go to the one Images window (${a.trim()}, ${b.trim()})`);
    await cli(env, 'app', 'images', 'view', '--source', 'project');
    await sleep(1200);
    const frame = appFrame(page, 'images');
    const tiles = await frame.locator('.img-tile').count();
    const loaded = await frame.locator('.img-tile img').first().evaluate((i) => i.complete && i.naturalWidth > 0).catch(() => false);
    check(tiles > 3 && loaded, `the Project tab lists the project folder's images, and they load (${tiles})`);
    await page.locator('[data-window="images"]').screenshot({ path: join(shots, '06i-image-project.png') });
    await cli(env, 'app', 'images', 'view', '--source', 'shown');
  }

  // Tests: the summary's flask stacks recent runs (green/red), with a run in progress on top in yellow.
  {
    const bash = (e, stdout, id) => event(env, { e, tool: 'Bash', id, input: { command: 'npx vitest run' }, ...(e === 'tool.end' ? { result: { stdout } } : {}) });
    const results = ['Tests  12 passed (12)', 'Tests  2 failed | 10 passed (12)', 'Tests  12 passed (12)', 'Tests  12 passed (12)', 'Tests  1 failed | 11 passed (12)', 'Tests  12 passed (12)'];
    for (const [i, out] of results.entries()) await bash('tool.end', out, `t${i}`);
    await bash('tool.start', '', 'tlive');
    await cli(env, 'window', 'open', 'tests');
    await sleep(900);
    const t = appFrame(page, 'tests');
    const slices = await t.locator('.ts-flask .liquid').count();
    const live = await t.locator('.ts-flask .liquid.run').count();
    await page.locator('[data-window="tests"]').screenshot({ path: join(shots, '16-tests-flask.png') });
    // (>=: the seed may hold earlier runs)
    check(slices >= results.length + 1 && live === 1, `the tests flask stacks each recent run, plus the running one in yellow (${slices} slices, ${live} running)`);
    await bash('tool.end', 'Tests  12 passed (12)', 'tlive');
    await sleep(500);
    check((await t.locator('.ts-flask .liquid.run').count()) === 0, 'when the run finishes, its slice turns green or red');
    await cli(env, 'window', 'close', 'tests');
  }

  // Files → Changes: clicking a changed file opens its diff in Changes.
  {
    await cli(env, 'window', 'open', 'files');
    await cli(env, 'app', 'files', 'view', '--mode', 'list');
    await sleep(800);
    const row = appFrame(page, 'files').locator('.fl-row.edited').first();
    const path = ((await row.getAttribute('title').catch(() => '')) ?? '').replace(/: show the change$/, '');
    await cli(env, 'window', 'move', 'changes', 7); // off to another desktop, so revealing it shows
    await sleep(500);
    await row.click();
    await sleep(900);
    const st = JSON.parse(await cli(env, 'state', 'changes')).state;
    const v = JSON.parse(await cli(env, 'view', '--json'));
    const page2 = v.desktops.find((d) => d.windows.some((w) => w.id === 'changes'))?.desktop;
    check(!!path && st.selected?.endsWith(path) && page2 === v.userViewingDesktop,
      `clicking a changed file in Files selects it in Changes and shows Changes (${path} → desktop ${page2 + 1}, viewing ${v.userViewingDesktop + 1})`);
    await cli(env, 'window', 'close', 'files');
    await page.locator('.pager button').first().click(); // back to desktop 1
    await sleep(600);
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
  // ⌘V works in text fields: the Edit menu carries the paste role (macOS routes the keys through it),
  // and pasting into a field puts the clipboard there.
  {
    const roles = await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.find((i) => i.label === 'Edit').submenu.items.map((i) => i.role));
    await app.evaluate(({ clipboard }) => clipboard.writeText('pasted text'));
    await page.locator('input[placeholder="Preset name"]').focus();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('renderer/index.html')).webContents.paste());
    const pasted = await page.locator('input[placeholder="Preset name"]').inputValue();
    check(roles.includes('paste') && roles.includes('cut') && pasted === 'pasted text', `the Edit menu has paste, and pasting fills a field ("${pasted}")`);
    await page.locator('input[placeholder="Preset name"]').fill('');
  }
  // Presets: save this glass from the form; it lists with Apply / Make default.
  await page.locator('input[placeholder="Preset name"]').fill('Focus');
  await page.locator('input[placeholder^="What it\'s for"]').fill('Terminal along the bottom, conversation on the left');
  await page.locator('button', { hasText: 'Save this glass' }).click();
  await sleep(400);
  check((await page.locator('.s-preset').count()) === 1 && (await cli(env, 'preset', 'list')).includes('Focus — Terminal along the bottom'), 'Settings saves the glass as a preset');
  await page.locator('.s-preset').first().evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await sleep(150);
  await page.locator('[data-window="settings"]').screenshot({ path: join(shots, '07f-settings-presets.png') });
  await cli(env, 'preset', 'delete', 'Focus');
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

  // Launcher order follows window order; auto-hide gives the space back and reveals at the bottom edge.
  // (Grouping off here, so each window has its own icon.)
  {
    await cli(env, 'settings', 'set', 'launcherGroup', 'false');
    await sleep(300);
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
    await cli(env, 'settings', 'set', 'dockAutoHide', 'false'); // the old name still works
    await cli(env, 'settings', 'set', 'launcherGroup', 'true');
    await sleep(500);
  }

  // Opened from a session the mod never ran in: the top bar says nothing feeds the glass, until an event arrives.
  {
    const out = await cli(env, 'open');
    await sleep(400);
    await page.screenshot({ path: join(shots, '08a-mod-missing.png') });
    check(out.includes("mod isn't running") && (await page.locator('.mod-missing').count()) === 1, 'opening without the mod warns, in the CLI and the top bar');
  }

  // Streaming + working state
  await event(env, { e: 'turn.start', turnId: 't2', text: 'Show me the final diff.' });
  await event(env, { e: 'tool.start', tool: 'Bash', input: { command: 'npm run build' }, id: 'live1' });
  await event(env, { e: 'text', id: 't2:0:0', turnId: 't2', text: 'Building now, then I will' });
  await sleep(500);
  await page.screenshot({ path: join(shots, '08-working.png') });
  check((await page.locator('.presence-working').count()) === 1, 'presence shows working');
  check((await page.locator('.mod-missing').count()) === 0, 'the not-connected notice goes once events arrive');
  check((await page.locator('.turn-bar.sweep').count()) === 1, 'the turn bar sweeps along the bottom while Claude works');
  await event(env, { e: 'step', turnId: 't2', index: 1 });
  await sleep(150);
  await page.screenshot({ path: join(shots, '08d-turn-bar.png'), clip: { x: 0, y: (page.viewportSize()?.height ?? 900) - 120, width: page.viewportSize()?.width ?? 1440, height: 120 } });

  // The context gauge: how full Claude's context is, from the mod's measure.
  await event(env, { e: 'usage', context: { tokens: 172000, window: 200000, percent: 86 }, cost: { usd: 1.23 } });
  await sleep(300);
  check((await page.locator('.ctx-gauge.full').innerText()).includes('86%'), 'the context gauge shows how full the context is (and warns near full)');
  await page.locator('header.topbar').screenshot({ path: join(shots, '08f-context-gauge.png') });

  // Attention: with followEdits on, an edit brings Changes to the front and lights it.
  {
    await cli(env, 'settings', 'set', 'followEdits', 'both');
    await cli(env, 'window', 'move', 'changes', '3');
    await event(env, { e: 'tool.end', tool: 'Edit', id: 'follow1', input: { file_path: join(project(env), 'src/core/server.ts'), old_string: 'a', new_string: 'b' },
      result: { structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }] } });
    await sleep(500);
    const st = JSON.parse(await cli(env, 'view', '--json'));
    check(st.desktops[0].windows[0].id === 'changes' && (await page.locator('.sig-ring.sig-spotlight').count()) === 1, 'followEdits: an edit brings its diff to the front and lights it');
    await page.screenshot({ path: join(shots, '08e-follow-edit.png') });
    await cli(env, 'settings', 'set', 'followEdits', 'off');
    await cli(env, 'signal', 'clear');
    // Turns: Changes can list only what the latest turn changed; the terminal marks where turns start.
    const d = appFrame(page, 'changes');
    await d.locator('.d-scope button', { hasText: 'This turn' }).click();
    await sleep(300);
    const files = await d.locator('.d-files li').count();
    await page.locator('[data-window="changes"]').screenshot({ path: join(shots, '08g-changes-this-turn.png') });
    check(files === 1 && (await d.locator('.d-files li').innerText()).includes('server.ts'), `Changes: "This turn" lists only the latest turn's files (${files})`);
    await d.locator('.d-scope button', { hasText: 'All' }).click();
    // Point and ask: "Ask about this" puts the change on the next prompt, as a chip in the top bar.
    await d.locator('.d-attach').click();
    await sleep(300);
    const chip = page.locator('.attach-chip');
    check((await chip.count()) === 1 && (await chip.innerText()).includes('server.ts'), 'Ask about this attaches the change: a chip in the top bar');
    await page.locator('header.topbar').screenshot({ path: join(shots, '08k-attached.png') });
    await chip.locator('button').click();
    await sleep(200);
    check((await page.locator('.attach-chip').count()) === 0, 'the chip\'s × takes it off again');
    // From the terminal: a hovered entry's Ask.
    const t = appFrame(page, 'terminal');
    const entry = t.locator('.t-entry', { hasText: 'git diff --stat' }).first();
    await entry.hover();
    await entry.locator('.t-ask').click();
    await sleep(300);
    check((await page.locator('.attach-chip').innerText()).includes('git diff --stat'), 'a terminal entry\'s Ask attaches the call and its output');
    await page.locator('.attach-chip button').click();
    await t.locator('.t-scroll').evaluate((el) => { el.scrollTop = el.scrollHeight; }); // (hovering scrolled it up)
    // From a markdown window: select text, then the pill.
    const planId = JSON.parse(await cli(env, 'view', '--json')).desktops.flatMap((d) => d.windows).find((w) => w.title === 'Plan')?.id;
    if (planId) {
      const md = appFrame(page, planId);
      await md.locator('article.md p').first().evaluate((p) => {
        const r = document.createRange(); r.selectNodeContents(p);
        const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
        p.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      });
      await sleep(300);
      await page.locator(`[data-window="${planId}"]`).screenshot({ path: join(shots, '08l-markdown-ask.png') });
      await md.locator('.md-ask').click();
      await sleep(300);
      check((await page.locator('.attach-chip').innerText()).includes('PLAN.md'), 'selected text in a markdown window can be attached');
      await page.locator('.attach-chip button').click();
    } else check(false, 'the Plan window is on screen for the markdown attach check');
    check((await appFrame(page, 'terminal').locator('.t-turn').count()) >= 2, 'the terminal marks where each turn starts');
  }

  // Waiting on the user: permission prompt (pill + terminal lock), then a question (read-only card).
  await cli(env, 'window', 'move', 'terminal', '0');
  await event(env, { e: 'permission', tool: 'Bash', input: { command: 'npm run build' } });
  await sleep(500);
  await page.screenshot({ path: join(shots, '08b-waiting-permission.png') });
  check((await page.locator('.presence-waiting').count()) === 1 && (await appFrame(page, 'terminal').locator('.t-locked').count()) === 1, 'permission prompt shows waiting pill and locks the terminal row');
  {
    const gap = await appFrame(page, 'terminal').locator('.t-scroll').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
    check(gap < 5, `terminal stays scrolled to the newest entry (gap ${gap}px)`);
  }
  check((await page.locator('.glass.waiting-glow').count()) === 1, 'waiting glow is on by default');
  await event(env, { e: 'tool.end', tool: 'Bash', input: { command: 'npm run build' }, id: 'live1', result: { stdout: 'built' } });
  await event(env, {
    e: 'tool.start', tool: 'AskUserQuestion', id: 'ask1',
    input: { questions: [{ header: 'Deploy', question: 'Ship the build to staging now?', multiSelect: false, options: [
      { label: 'Yes, ship it', description: 'Deploys the build you just made to staging' },
      { label: 'Not yet', description: 'Keep working locally' }] }] },
  });
  await sleep(500);
  await page.screenshot({ path: join(shots, '08c-waiting-question.png') });
  const card = page.locator('.question-card');
  check((await card.count()) === 1 && (await card.locator('button').count()) === 0 && (await card.innerText()).includes('Answer in Claude Code'), 'question card is shown, read-only');
  await event(env, { e: 'tool.end', tool: 'AskUserQuestion', id: 'ask1', input: {}, result: {} });
  await sleep(400);
  check((await page.locator('.question-card').count()) === 0 && (await page.locator('.presence-waiting').count()) === 0, 'answering clears the waiting state');

  // Approvals: the mod asks through the glass; the Action app's card answers it (the CLI waits).
  {
    const bin = join(root, 'bin/claude-glass');
    const req = JSON.parse(await run(bin, ['action', 'request'], env, JSON.stringify({ tool: 'Bash', input: { command: 'git push origin main' }, canAlways: true })));
    await event(env, { e: 'permission', tool: 'Bash', input: { command: 'git push origin main' } });
    await sleep(700);
    await page.screenshot({ path: join(shots, '08h-approval.png') });
    const card = appFrame(page, 'action').locator('.ac-req.pending');
    check((await card.count()) === 1 && (await card.innerText()).includes('git push origin main'), 'a permission request shows as a card in Action, at the front');
    const answer = run(bin, ['action', 'wait', req.id, '--ms', '8000'], env);
    await sleep(200);
    await card.locator('button.primary').click();
    const got = JSON.parse(await answer);
    check(got.status === 'answered' && got.choice === 'allow' && got.by === 'glass', `Allow on the card answers the waiting mod (${JSON.stringify(got)})`);
    await sleep(400);
    await page.locator('[data-window="action"]').screenshot({ path: join(shots, '08i-approval-answered.png') }).catch(() => {});
    await event(env, { e: 'tool.end', tool: 'Bash', id: 'pushed', input: { command: 'git push origin main' }, result: { stdout: '' } });
    await sleep(1800);
    check((await page.locator('[data-window="action"]').count()) === 0, 'once answered, the card and its window go away');

    // The questions experiment: Claude's question as a card; one click answers it.
    await cli(env, 'settings', 'set', 'app.action.questions', 'true');
    const input = { questions: [
      { question: 'Ship the fix now, or add the regression test first?', header: 'Next step', multiSelect: false, options: [
        { label: 'Add the test first', description: '50 reconnects, expect 0 re-renders' }, { label: 'Ship now', description: 'Test in a follow-up' }] },
    ] };
    const q = JSON.parse(await run(bin, ['action', 'request'], env, JSON.stringify({ kind: 'question', tool: 'AskUserQuestion', input })));
    await event(env, { e: 'tool.start', tool: 'AskUserQuestion', id: 'ask-q', input });
    await sleep(700);
    await page.screenshot({ path: join(shots, '08j-question-card.png') });
    check((await page.locator('.question-card').count()) === 0, 'the read-only question card steps aside while Action has the question');
    const qAnswer = run(bin, ['action', 'wait', q.id, '--ms', '8000'], env);
    await sleep(200);
    await appFrame(page, 'action').locator('.ac-options button', { hasText: 'Add the test first' }).click();
    const qGot = JSON.parse(await qAnswer);
    check(qGot.answers?.['Ship the fix now, or add the regression test first?'] === 'Add the test first', `a click on an option answers Claude's question (${JSON.stringify(qGot)})`);
    await event(env, { e: 'tool.end', tool: 'AskUserQuestion', id: 'ask-q', input, result: { questions: input.questions, answers: qGot.answers } });
    await cli(env, 'settings', 'set', 'app.action.questions', 'false');
    await sleep(1800);
  }

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
      await event(env, { e: 'tool.start', tool: 'WebSearch', id: 'ws1', input: { query: 'CDP screencast parameters' } });
      await sleep(400);
      check((await appFrame(page, 'browser').locator('.browserview .b-meta').innerText()).includes('searching'), 'web search shows while searching');
      await event(env, { e: 'tool.end', tool: 'WebSearch', id: 'ws1', input: { query: 'CDP screencast parameters' },
        result: { query: 'CDP screencast parameters', results: [{ tool_use_id: 'x', content: [
          { title: 'Chrome DevTools Protocol - Page domain', url: 'https://chromedevtools.github.io/devtools-protocol/tot/Page/' },
          { title: 'How to do video recording on headless chrome', url: 'https://medium.com/@anchen.li/how-to-do-video-recording' },
          { title: 'puppeteer screen recorder', url: 'https://github.com/axelboberg/puppeteer-screen-recorder' }] }, 'Summary text'] } });
      await sleep(500);
      await page.screenshot({ path: join(shots, '09c-web-search.png') });
      check((await appFrame(page, 'browser').locator('.b-results li').count()) === 3, 'web search results are listed');
      await event(env, { e: 'tool.start', tool: 'WebFetch', id: 'wf1', input: { url, prompt: 'params?' } });
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
      await event(env, { e: 'tool.start', tool: 'WebFetch', id: 'wf2', input: { url: longUrl, prompt: 'x' } });
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

  // Custom app: sandboxed frame view, props over the bridge, view commands, CLI commands.
  {
    await cli(env, 'window', 'open', 'tool-count');
    await cli(env, 'app', 'tool-count', 'note', '--text', 'Hello from a custom app');
    await sleep(700);
    const frame = page.frameLocator('[data-window="tool-count"] iframe.appframe');
    const note = await frame.locator('#note').textContent({ timeout: 4000 }).catch(() => '');
    check(note === 'Hello from a custom app', `custom app view renders its state (note: ${note})`);
    check((await frame.locator('.row').count()) >= 3, 'custom app filled itself from session events (onEvent)');
    await frame.locator('button[data-by="name"]').click();
    await sleep(300);
    const st = JSON.parse(await cli(env, 'state', 'tool-count')).state;
    check(st.sort === 'name', 'custom app view ran its view command');
    await page.screenshot({ path: join(shots, '10-custom-app.png') });
    const guide = JSON.parse(await cli(env, 'catalog', '--json')).find((a) => a.type === 'tool-count');
    check(guide?.source === 'user', 'custom app is in the catalog');
    const iconOk = await page.locator('.dock-item[data-dock-id="tool-count"] .tile img.app-icon').evaluate((img) => img.complete && img.naturalWidth > 0).catch(() => false);
    check(iconOk, 'a custom app shows its own image icon in the dock');
  }

  // Nested view (global setting): one spiral page, no layout button.
  {
    await cli(env, 'settings', 'set', 'nestedView', 'true');
    await sleep(700);
    await page.screenshot({ path: join(shots, '11-nested-view.png') });
    check((await page.locator('.light.layout').count()) === 0 && (await page.locator('.pager button').count()) === 1, 'nested view: one page, layout buttons hidden');
    // Carousel: the focused window in the middle, neighbors as smaller tiles either side (3 rows);
    // with nothing newer, the middle window stretches left; clicking a tile brings it to the middle.
    const made = [];
    for (let i = 0; i < 8; i++) made.push((await cli(env, 'new', 'markdown', '--title', `Tile ${i}`)).trim().split(' ')[0]);
    await cli(env, 'settings', 'set', 'nestedStyle', 'watch'); // the first name still works
    await sleep(900);
    await page.screenshot({ path: join(shots, '11b-carousel.png') });
    const order = JSON.parse(await cli(env, 'view', '--json')).desktops[0].windows.map((w) => w.id);
    const box = (id) => page.locator(`[data-window="${id}"]`).boundingBox();
    const [mid, next, third] = [await box(order[0]), await box(order[1]), await box(order[3])];
    const W = await page.evaluate(() => innerWidth);
    check(mid.x < 40 && next.x > mid.x + mid.width && next.width < mid.width / 3 && third.y > next.y + next.height,
      `carousel: newest window fills the empty left side (x ${Math.round(mid.x)}), the next ones tiles on the right in 3 rows`);
    await page.mouse.click(next.x + next.width / 2, next.y + next.height / 2);
    await sleep(700);
    const moved = await box(order[1]);
    check(Math.abs(moved.x + moved.width / 2 - W / 2) < 40, `carousel: clicking a tile brings it to the middle (${Math.round(moved.x)})`);
    await page.screenshot({ path: join(shots, '11c-carousel-focused.png') });
    // Closing the focused window keeps focus where it was: the next one slides into the middle
    // (it used to jump back to the newest).
    await page.locator(`[data-window="${order[1]}"] .light.close`).click();
    await sleep(800);
    const took = await box(order[2]);
    check(Math.abs(took.x + took.width / 2 - W / 2) < 40, `carousel: closing the focused window focuses the one that took its place (${order[2]} at ${Math.round(took.x)})`);
    await page.locator(`[data-window="${order[2]}"] .light.close`).click();
    await sleep(800);
    const took2 = await box(order[3]);
    check(Math.abs(took2.x + took2.width / 2 - W / 2) < 40, `carousel: closing neighbors one after another walks along the row (${order[3]} at ${Math.round(took2.x)})`);
    await cli(env, 'settings', 'set', 'nestedStyle', 'spiral');
    for (const id of made) await cli(env, 'window', 'delete', id);
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
    // Crowd the launcher (grouping off): icons shrink to fit, and it never runs off the window.
    await cli(env, 'settings', 'set', 'launcherGroup', 'false');
    const made = [];
    for (let i = 0; i < 30; i++) made.push((await cli(env, "new", "markdown", "--title", `Crowd ${i}`)).trim()); // open: the launcher holds open windows
    await sleep(500);
    const fit = await page.evaluate(() => ({ dock: document.querySelector('.dock').getBoundingClientRect().width, win: innerWidth, tile: document.querySelector('.dock-item .tile').getBoundingClientRect().width }));
    check(fit.dock <= fit.win && fit.tile < 38, `a crowded launcher shrinks its icons and stays on screen (${Math.round(fit.tile)}px icons, launcher ${Math.round(fit.dock)} of ${fit.win})`);
    await page.screenshot({ path: join(shots, '13-dock.png') });
    // Grouping on (the default): the markdown windows share one icon with a count; clicking it
    // lists them, and picking one opens it.
    await cli(env, 'settings', 'set', 'launcherGroup', 'true');
    await sleep(500);
    const group = page.locator('.dock-item.group[data-dock-group="markdown"]');
    const count = Number(await group.locator('.count').innerText());
    const icons = await page.locator('.dock-item').count();
    check(count >= 30 && icons < count, `launcher groups an app's windows under one icon (markdown ×${count}, ${icons} icons)`);
    await group.click();
    await sleep(300);
    const listed = await page.locator('.launcher-menu button').count();
    await page.screenshot({ path: join(shots, '13b-launcher-group.png') });
    check(listed === count, `clicking a group lists its windows (${listed})`);
    await page.locator('.launcher-menu button', { hasText: 'Crowd 7' }).click();
    await sleep(500);
    const openNow = JSON.parse(await cli(env, 'view', '--json')).desktops.flatMap((d) => d.windows.map((w) => w.id));
    check(openNow.includes(made[7]) && (await page.locator('.launcher-menu').count()) === 0, `picking a window from the group opens it and closes the menu (${made[7]})`);
    for (const id of made) await cli(env, 'window', 'close', id);
    await sleep(500);
    // Closed windows leave the launcher; the Apps button lists them (and apps to start).
    const inLauncher = await page.locator(`.dock-item[data-dock-id="${made[3]}"], .dock-item.group[data-dock-group="markdown"]`).count();
    await page.locator('.dock-item[data-apps]').click();
    await sleep(300);
    const md = page.locator('.apps-tile[data-app="markdown"]');
    const badge = Number(await md.locator('.count').innerText().catch(() => '0'));
    const tiles = await page.locator('.apps-tile').count();
    await md.hover();
    await sleep(250);
    const closedRows = await page.locator('.apps-sub .apps-row', { hasText: 'Crowd' }).count();
    await page.screenshot({ path: join(shots, '13c-apps.png') });
    check(inLauncher === 0 && badge >= 30 && closedRows === 30 && tiles > 3, `closed windows leave the launcher; Apps badges markdown (${badge}) and hovering lists them (${closedRows}), among ${tiles} apps`);
    await page.locator('.apps-sub .apps-row', { hasText: 'Crowd 3' }).first().click();
    await sleep(500);
    const reopened = JSON.parse(await cli(env, 'view', '--json')).desktops.flatMap((d) => d.windows.map((w) => w.id));
    check(reopened.includes(made[3]) && (await page.locator('.apps-menu').count()) === 0, `picking a closed window in Apps reopens it (${made[3]})`);
    for (const id of made) await cli(env, 'window', 'delete', id);
  }

  // Corner docks: dock at a corner (CLI or the corner's drop target); hover the corner to pull it,
  // click to open; kept open, a corner takes the end of its side's column and the edge dock fits
  // beside it. Open backings meeting at an inside corner get a rounded fillet. A kept dock's pin
  // hides until hovered. With dockOpen hover, hovering opens a dock without a click.
  {
    await sleep(400);
    const stage = await page.locator('.stage').boundingBox();
    // Small steps, like a real pointer: it crosses the gaps between windows, where the shell sees it.
    const away = () => page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2, { steps: 16 });
    const lay = JSON.parse(await cli(env, 'view', '--json')).desktops[0].windows.map((w) => w.id);
    await cli(env, 'window', 'dock', lay[0], 'top-right');
    await sleep(400);
    await away();
    await sleep(400);
    await page.screenshot({ path: join(shots, '12i2-corner-idle.png'), clip: { x: stage.x + stage.width - 260, y: stage.y, width: 260, height: 200 } });
    await page.mouse.move(stage.x + stage.width - 6, stage.y + 6, { steps: 4 });
    await sleep(400);
    // Check before the screenshot: taking one can drop the hover in the test harness.
    check((await page.locator('.edge-cap.top-right.near').count()) === 1 && (await page.locator('.edge-panel.top-right.open').count()) === 0,
      'hovering a corner starts pulling its dock out (without opening it)');
    await page.screenshot({ path: join(shots, '12i3-corner-near.png'), clip: { x: stage.x + stage.width - 260, y: stage.y, width: 260, height: 200 } });
    await page.mouse.move(stage.x + stage.width - 7, stage.y + 7); // re-hover after the screenshot, like a real pointer
    await page.mouse.down(); await page.mouse.up();
    await sleep(700);
    const tr = await page.locator('.edge-panel.top-right').boundingBox();
    check((await page.locator('.edge-panel.top-right.open').count()) === 1 && tr.x + tr.width > stage.x + stage.width - 20 && tr.y < stage.y + 20 && tr.height < stage.height * 0.7,
      `clicking the corner opens the corner dock, in the corner (${Math.round(tr.width)}×${Math.round(tr.height)})`);
    await page.locator('.edge-cap.top-right.open').click(); // keep it open
    await cli(env, 'window', 'dock', lay[1], 'right');
    await cli(env, 'window', 'dock', lay[2], 'top');
    await sleep(300);
    for (const e of ['right', 'top']) {
      await away();
      const pt = e === 'right' ? [stage.x + stage.width - 4, stage.y + stage.height * 0.6] : [stage.x + stage.width * 0.4, stage.y + 4];
      await page.mouse.move(pt[0], pt[1], { steps: 3 });
      await page.mouse.down(); await page.mouse.up();
      await sleep(600);
      await page.locator(`.edge-cap.${e}.open`).click();
      await sleep(300);
    }
    await away();
    await sleep(700);
    const [C, R, T] = [await page.locator('.edge-panel.top-right').boundingBox(), await page.locator('.edge-panel.right').boundingBox(), await page.locator('.edge-panel.top').boundingBox()];
    check(R.y >= C.y + C.height && T.x + T.width <= Math.min(C.x, R.x), `a kept corner takes the top of the right column; the right dock fits below it, the top dock beside (corner ends ${Math.round(C.y + C.height)}, right starts ${Math.round(R.y)})`);
    // A bottom dock only makes room for what reaches the bottom: the right dock, not the top-right corner.
    await cli(env, 'window', 'dock', lay[3], 'bottom');
    await sleep(300);
    await away();
    await page.mouse.move(stage.x + stage.width * 0.4, stage.y + stage.height - 4, { steps: 3 });
    await page.mouse.down(); await page.mouse.up();
    await sleep(600);
    await page.locator('.edge-cap.bottom.open').click();
    await away();
    await sleep(600);
    const Bt = await page.locator('.edge-panel.bottom').boundingBox();
    check(Bt.x <= stage.x + 13 && Bt.x + Bt.width <= R.x, `a kept bottom dock runs the full width a top corner leaves it (x ${Math.round(Bt.x - stage.x)}, ends ${Math.round(Bt.x + Bt.width)} before the right dock at ${Math.round(R.x)})`);
    // Top/bottom docks resize from their inner edge too (height).
    const bh = await page.locator('.edge-resize.bottom').boundingBox();
    await page.mouse.move(bh.x + bh.width / 4, bh.y + bh.height / 2); // off the pin in the middle
    await page.mouse.down();
    await page.mouse.move(bh.x + bh.width / 4, bh.y - 80, { steps: 6 });
    await page.mouse.up();
    await sleep(400);
    const taller = (await page.locator('.edge-panel.bottom').boundingBox()).height;
    check(taller > Bt.height + 50, `dragging a bottom dock's inner edge resizes it (${Math.round(Bt.height)} → ${Math.round(taller)}px)`);
    await away();
    await sleep(400);
    // No backing (Graphite Mono): nothing solid behind the docks; hovering an open dock frames it and
    // shows the lock pill, which says what a click does.
    check((await page.locator('.edge-rail, .edge-fillet').count()) === 0, 'docks have no solid backing');
    await page.mouse.move(R.x + R.width / 2, R.y + 16, { steps: 4 });
    await sleep(400);
    const lock = await page.locator('.edge-cap.right.open').evaluate((e) => ({ kept: e.getAttribute('aria-pressed'), title: e.getAttribute('title'), opacity: getComputedStyle(e).opacity }));
    const framed = await page.locator('.edge-panel.right.hover').count();
    check(lock.kept === 'true' && lock.title?.startsWith('Release') && lock.opacity === '1' && framed === 1, `hovering a kept dock frames it and shows its lock (${lock.title})`);
    await away();
    await sleep(400);
    const pinHidden = await page.locator('.edge-cap.right.open.kept').evaluate((e) => getComputedStyle(e).opacity === '0');    await page.mouse.move(R.x + R.width / 2, R.y + 16, { steps: 3 }); // over its title bar (a synthetic jump into a frame isn't seen)
    await sleep(400);
    const pinShown = await page.locator('.edge-cap.right.open.kept').evaluate((e) => getComputedStyle(e).opacity === '1');    check(pinHidden && pinShown, 'a kept dock\'s pin stays hidden until the pointer is over the dock');
    await away();
    await sleep(700);
    const pinBack = await page.locator('.edge-cap.right').evaluate((e) => `${e.className} · opacity ${getComputedStyle(e).opacity}`);
    check(pinBack.endsWith('opacity 0'), `and hides again once the pointer leaves (${pinBack})`);
    await page.screenshot({ path: join(shots, '12j-corner-docks.png') });
    // Resize the kept corner from its inner corner: both dimensions change.
    const before = JSON.parse(await cli(env, 'view', '--json')).sidebars['top-right'];
    const h = await page.locator('.edge-resize.corner.top-right').boundingBox();
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
    await page.mouse.down();
    await page.mouse.move(h.x - 80, h.y + 60, { steps: 6 });
    await page.mouse.up();
    await sleep(400);
    const after = JSON.parse(await cli(env, 'view', '--json')).sidebars['top-right'];
    check(after.size > before.size + 50 && after.height > before.height + 30, `dragging a corner dock's inner corner resizes both ways (${before.size}×${before.height} → ${after.size}×${after.height})`);
    for (const id of lay.slice(0, 4)) await cli(env, 'window', 'undock', id);
    await sleep(500);
    // Drop on a corner's target to dock there.
    const w = JSON.parse(await cli(env, 'view', '--json')).desktops[0].windows[0].id;
    const tb = await page.locator(`.strip [data-window="${w}"] .titlebar`).first().boundingBox();
    await page.mouse.move(tb.x + tb.width / 2, tb.y + 18);
    await page.mouse.down();
    await away();
    const tgt = await page.locator('.pin-target.bottom-left').boundingBox();
    await page.mouse.move(tgt.x + tgt.width / 2, tgt.y + tgt.height / 2, { steps: 6 });
    await sleep(150);
    const lit = await page.locator('.pin-target.bottom-left.on').count();
    await page.screenshot({ path: join(shots, '12k-corner-target.png') });
    await page.mouse.up();
    await sleep(500);
    let v = JSON.parse(await cli(env, 'view', '--json'));
    check(lit === 1 && v.tucked?.['bottom-left']?.[0]?.id === w, `dropping on a corner's target docks the window there (${JSON.stringify(Object.keys(v.tucked ?? {}))})`);
    // Open on hover: no click needed.
    await cli(env, 'settings', 'set', 'dockOpen', 'hover');
    await away();
    await sleep(500);
    await page.mouse.move(stage.x + 6, stage.y + stage.height - 6, { steps: 4 });
    await sleep(700);
    check((await page.locator('.edge-panel.bottom-left.open').count()) === 1, 'with dockOpen hover, hovering a dock\'s tab opens it');
    await away();
    await sleep(900);
    check((await page.locator('.edge-panel.bottom-left.open').count()) === 0, 'and it closes when the pointer leaves');
    await cli(env, 'settings', 'set', 'dockOpen', 'click');
    await cli(env, 'window', 'undock', w);
    await sleep(400);
  }

  // Background light: Claude's signal recolors the wallpaper blobs, easing over; reset restores.
  {
    // The first light's target color (the canvas eases to it over 1.6s).
    const blobColor = () => page.evaluate(() => document.querySelector('canvas.wallpaper-light').dataset.colors.split(',')[0]);
    const before = await blobColor();
    await cli(env, 'background', '--colors', '#c0392b,#8e2a1e');
    await sleep(2000);
    const signal = await blobColor();
    check(signal === '#c0392b', `Claude's background signal recolors the wallpaper light (${before} → ${signal})`);
    await page.screenshot({ path: join(shots, '14-signal.png') });
    await cli(env, 'background', 'reset');
    await sleep(2000);
    check((await blobColor()) === before, 'background reset brings back the usual light');
    // State colors (off by default now; the signal layer says the same): done → green; a new prompt
    // → back to the user's own light.
    await cli(env, 'settings', 'set', 'stateColors', 'true');
    await event(env, { e: 'turn.complete', turnId: 't2' });
    await sleep(2000);
    const done = await blobColor();
    check(done === '#27ae60', `state colors: the light turns green when Claude is done (${done})`);
    await page.screenshot({ path: join(shots, '14b-state-idle.png') });
    await event(env, { e: 'turn.start', turnId: 't3', text: 'next' });
    await sleep(2000);
    const working = await blobColor();
    check(working !== done, `state colors: working goes back to the user's own light (${working})`);
    await cli(env, 'settings', 'set', 'stateColors', 'false');
  }

  // The signal layer: Claude spotlights a window (light behind it, its edge lit), alerts one, shows
  // progress; each spotlight/alert fades on its own. Then light mode.
  {
    await sleep(400);
    const target = JSON.parse(await cli(env, 'view', '--json')).desktops[0].windows[0].id;
    await cli(env, 'signal', 'spotlight', target);
    await sleep(900);
    const spot = await page.evaluate((id) => {
      const g = document.querySelector('.sig-glow.sig-spotlight'), r = document.querySelector('.sig-ring.sig-spotlight');
      const w = document.querySelector(`.stage [data-window="${id}"]`)?.getBoundingClientRect(), rr = r?.getBoundingClientRect();
      return { glow: !!g && Number(getComputedStyle(g).opacity) > 0.2, ringOn: !!rr && !!w && Math.abs(rr.left - w.left) < 2 && Math.abs(rr.width - w.width) < 2 };
    }, target);
    await page.screenshot({ path: join(shots, '17-signal-spotlight.png') });
    check(spot.glow && spot.ringOn, `a spotlight lights behind the window and rings it (${JSON.stringify(spot)})`);
    await sleep(5000);
    check((await page.locator('.sig-glow.sig-spotlight').count()) === 0, 'the spotlight fades on its own');
    await cli(env, 'signal', 'progress', '0.4', '--label', 'Migrating apps');
    await sleep(700);
    const bar = await page.evaluate(() => ({ w: document.querySelector('.sig-bar i')?.getBoundingClientRect().width, W: innerWidth, label: document.querySelector('.sig-bar span')?.textContent }));
    await page.screenshot({ path: join(shots, '17b-signal-progress.png') });
    check(Math.abs(bar.w / bar.W - 0.4) < 0.03 && bar.label?.includes('Migrating apps'), `progress shows a hairline bar with its label (${Math.round((bar.w / bar.W) * 100)}%, "${bar.label}")`);
    await cli(env, 'signal', 'progress', '1');
    await sleep(500);
    check((await page.locator('.sig-bar').count()) === 0, 'progress at 1 ends it');
    let bad = false;
    try { await cli(env, 'signal', 'alert', 'nope'); } catch { bad = true; }
    check(bad, 'an alert at a window that does not exist is refused');
    // Light mode: the shell and app frames switch together.
    await cli(env, 'settings', 'set', 'theme', 'light');
    await sleep(900);
    const themes = await page.evaluate(() => document.documentElement.dataset.theme);
    const frameTheme = await appFrame(page, 'terminal').locator('html').getAttribute('data-theme').catch(() => null);
    await page.screenshot({ path: join(shots, '18-light.png') });
    check(themes === 'light' && frameTheme === 'light', `light mode switches the shell and app frames (${themes}, frame ${frameTheme})`);
    await cli(env, 'settings', 'set', 'theme', 'dark');
    await sleep(500);
  }

  // Two windows in one sidebar: drag the gap between them to change their shares.
  {
    const a = (await cli(env, 'new', 'markdown', '--title', 'Split A')).split(' ')[0];
    const b = (await cli(env, 'new', 'markdown', '--title', 'Split B')).split(' ')[0];
    await cli(env, 'window', 'pin', a, 'right');
    await cli(env, 'window', 'pin', b, 'right');
    await page.evaluate(() => window.glass.dispatch({ type: 'tuck.keep', edge: 'right', keep: true }));
    await sleep(700);
    const gap = await page.locator('.edge-panel.right .edge-split').boundingBox();
    const hA = async () => (await page.locator(`[data-window="${a}"]`).boundingBox()).height;
    const before = await hA();
    await page.mouse.move(gap.x + gap.width / 2, gap.y + gap.height / 2);
    await page.mouse.down();
    await page.mouse.move(gap.x + gap.width / 2, gap.y + 150, { steps: 6 });
    await page.mouse.up();
    await sleep(600);
    const after = await hA();
    const split = JSON.parse(await cli(env, 'state', '--json')).tuckSplit?.right;
    check(after > before + 100 && split?.[0] > 0.6, `dragging the gap in a sidebar resizes its windows (${Math.round(before)} → ${Math.round(after)}px, shares ${JSON.stringify(split)})`);
    await page.screenshot({ path: join(shots, '12i-sidebar-split.png') });
    await cli(env, 'window', 'delete', a);
    await cli(env, 'window', 'delete', b);
    await sleep(300);
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
  await event(env, { e: 'session.end', reason: 'other' });
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
