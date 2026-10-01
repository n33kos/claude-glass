// Regenerates the README's screenshots and GIF (docs/media/) from a throwaway glass seeded with
// demo content: node scripts/readme-media.mjs (after npm run build). Needs ffmpeg for the GIF.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { cli, event, seed } from '../test/e2e/seed.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'docs/media');
mkdirSync(out, { recursive: true });
const home = mkdtempSync(join(tmpdir(), 'cg-media-home-'));
const runtime = mkdtempSync('/tmp/cg-media-rt-');
const project = join(mkdtempSync(join(tmpdir(), 'cg-media-')), 'orbit'); // a neutral project name
mkdirSync(join(project, 'src'), { recursive: true });
const video = mkdtempSync(join(tmpdir(), 'cg-media-video-'));
// Still wallpaper: the drifting light would make every GIF frame different (and the GIF huge).
writeFileSync(join(home, 'config.json'), JSON.stringify({ defaultLayout: 'claude', background: 'aurora', windowOpacity: 0.8, animateBackground: false }));

const SID = 'readme-session';
const env = { ...process.env, CLAUDE_GLASS_HOME: home, CLAUDE_GLASS_RUNTIME: runtime, CLAUDE_CODE_SESSION_ID: SID, SEED_PROJECT: project };
delete env.ELECTRON_RUN_AS_NODE;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const W = 1440, H = 900;

const app = await electron.launch({
  args: [join(root, 'dist/main.js'), '--session', SID, '--cwd', project],
  env, recordVideo: { dir: video, size: { width: W, height: H } },
});
const t0 = Date.now();
const at = () => (Date.now() - t0) / 1000;
try {
  const page = await app.firstWindow();
  await page.waitForSelector('.window');
  const shot = async (name, el) => {
    const file = join(out, `${name}.png`);
    await (el ?? page).screenshot({ path: file });
    execFileSync('sips', ['-Z', '1600', file], { stdio: 'ignore' }); // retina → README size
  };

  // The hero: a session mid-fix. Conversation, terminal, the plan, the diffs and a chart.
  await seed(env);
  await cli(env, 'layout', '1', 'main-left-nest'); // all five on one desktop
  await sleep(1500);
  await shot('overview');

  // Waiting on you: Claude asked a question; the glass shows it (you answer in Claude Code).
  await event(env, {
    e: 'tool.start', tool: 'AskUserQuestion', id: 'toolu_ask',
    input: { questions: [{ question: 'Ship the fix now, or add the regression test first?', header: 'Next step', options: [{ label: 'Add the test first', description: '50 reconnects, expect 0 re-renders' }, { label: 'Ship now', description: 'Test in a follow-up' }] }] },
  });
  await sleep(1200);
  await shot('waiting');
  await event(env, { e: 'tool.end', tool: 'AskUserQuestion', id: 'toolu_ask', input: {}, result: {} });
  await event(env, { e: 'turn.complete', turnId: 't' });
  await sleep(1800);

  // A sidebar: the terminal pinned to the right edge and kept open beside the desktop.
  await cli(env, 'window', 'pin', 'terminal', 'right');
  await page.evaluate(() => window.glass.dispatch({ type: 'tuck.keep', edge: 'right', keep: true }));
  await sleep(1200);
  await shot('sidebar');
  await cli(env, 'window', 'unpin', 'terminal');
  await sleep(600);

  // The carousel: one window in the middle, its neighbors as tiles either side. Recorded.
  for (const [title, text] of [
    ['Notes', '# Reconnect notes\n\n- `ping` replays the full state\n- listeners fire on identical commits\n- React remounts every row\n\n**Fix:** skip no-op commits.'],
    ['Checklist', '# Release checklist\n\n1. Regression test\n2. Changelog\n3. Tag v0.4.1'],
    ['Timeline', '# Timeline\n\n| When | What |\n|---|---|\n| 10:02 | Bug reported |\n| 10:20 | Cause found |\n| 10:41 | Fix merged |'],
  ]) {
    const id = (await cli(env, 'new', 'markdown', '--title', title)).split(' ')[0];
    await cli(env, 'app', id, 'set', '--text', text);
  }
  await cli(env, 'settings', 'set', 'nestedView', 'true');
  await cli(env, 'settings', 'set', 'nestedStyle', 'carousel');
  await page.mouse.move(W / 2, 20);
  await sleep(1500);
  const clipStart = at();
  for (let i = 0; i < 4; i++) { await page.keyboard.press('Meta+ArrowRight'); await sleep(900); }
  for (let i = 0; i < 4; i++) { await page.keyboard.press('Meta+ArrowLeft'); await sleep(900); }
  const clipEnd = at();
  await page.keyboard.press('Meta+ArrowRight'); // mid-row for the still: tiles on both sides
  await page.keyboard.press('Meta+ArrowRight');
  await sleep(1200);
  await shot('carousel');
  await cli(env, 'settings', 'set', 'nestedView', 'false');
  await sleep(800);

  // Settings: the look section (background, light colors, state colors).
  await page.locator('.dock-item[title="Settings"]').click();
  await sleep(900);
  await page.locator('.s-color').first().evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await sleep(300);
  await shot('settings', page.locator('[data-window="settings"]'));

  await cli(env, 'close').catch(() => {});
  await sleep(300);
  const vpath = await page.video()?.path();
  await app.close().catch(() => {});
  if (vpath) {
    // GIF: the carousel clip, 800px wide, 12 fps, one shared palette; only changed pixels per frame.
    const gif = join(out, 'carousel.gif');
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(clipStart), '-t', String(clipEnd - clipStart), '-i', vpath,
      '-vf', 'fps=12,scale=800:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle', gif]);
    console.log(`wrote ${gif}`);
  }
  console.log(`media in ${out}`);
} finally {
  await app.close().catch(() => {});
  for (const d of [runtime, video]) rmSync(d, { recursive: true, force: true });
}
