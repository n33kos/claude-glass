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
  check(parseInt(zoom) > 150, `wheel zooms the lightbox (got ${zoom})`);
  await page.screenshot({ path: join(shots, '06g-lightbox-zoomed.png') });
  await page.keyboard.press('Escape');
  await sleep(150);
  check(await page.locator('.lightbox').count() === 0, 'Esc closes the lightbox');

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

  // Pin: click the pin on the window in slot 1, open a new window, the pinned one stays put.
  {
    const ids = () => cli(env, 'view', '--json').then((j) => JSON.parse(j).desktops.flatMap((d) => d.windows.map((w) => w.id)));
    const target = (await ids())[1];
    await page.locator(`[data-window="${target}"] .titlebar`).hover();
    await page.locator(`[data-window="${target}"] .pin`).click();
    await sleep(300);
    await cli(env, 'new', 'markdown', '--id', 'pin-test', '--title', 'New window');
    await sleep(600);
    const now = await ids();
    check(now[0] === 'pin-test' && now[1] === target, `pinned window keeps slot 1 when a new window opens (${now.slice(0, 3).join(', ')})`);
    await page.screenshot({ path: join(shots, '06e-pinned.png') });
    await cli(env, 'window', 'close', 'pin-test');
    await page.locator(`[data-window="${target}"] .pin`).click();
    await sleep(300);
    check(!(await cli(env, 'view')).includes('[pinned]'), 'clicking the pin again unpins');
  }

  // Settings via dock
  await page.locator('.dock-item[title="Settings"]').click();
  await sleep(700);
  await page.screenshot({ path: join(shots, '07-settings.png') });
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
    const srv = createServer((_q, r) => { r.setHeader('content-type', 'text/html; charset=utf-8'); r.end(`<title>Screencast docs</title>
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
