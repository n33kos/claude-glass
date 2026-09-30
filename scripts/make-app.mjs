// macOS: make Claude Glass.app, a renamed copy of Electron.app, so the dock and menu bar say
// "Claude Glass" with our icon. One bundle is shared by every installed version, in the glass home
// (~/.claude/claude-glass/app/<electron version>-<icon hash>/): macOS keys the microphone grant to
// the app's signature, and a bundle per plugin version (each signed ad hoc) made every update ask
// again. Built once per Electron version and icon, never replaced under a running glass.
// dist/app.json tells the launcher which bundle this version uses.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

if (process.platform !== 'darwin') process.exit(0);

const require = createRequire(import.meta.url);
const electronVersion = require('electron/package.json').version;
const src = 'node_modules/electron/dist/Electron.app';
const iconHash = createHash('sha256').update(readFileSync('assets/icon.png')).digest('hex').slice(0, 12);
const home = process.env.CLAUDE_GLASS_HOME || join(homedir(), '.claude', 'claude-glass');
const dir = join(home, 'app', `${electronVersion}-${iconHash}`);
const app = join(dir, 'Claude Glass.app');

const run = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'inherit'] });
mkdirSync('dist', { recursive: true });
const record = () => writeFileSync('dist/app.json', JSON.stringify({ app }, null, 2));

if (existsSync(app)) { record(); process.exit(0); }

// Newer npm versions can skip install scripts, including the one that downloads Electron itself.
if (!existsSync(src)) run(process.execPath, ['node_modules/electron/install.js']);

// Built beside its final place and renamed in, so a half-made bundle is never used and two builds
// at once (two versions' first runs) don't collide.
const tmp = `${dir}.tmp-${process.pid}`;
const tmpApp = join(tmp, 'Claude Glass.app');
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
run('cp', ['-Rc', src, tmpApp]); // APFS clone: instant, no extra disk

// Name and identity.
const plist = join(tmpApp, 'Contents', 'Info.plist');
const set = (key, value) => run('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]);
set('CFBundleName', 'Claude Glass');
set('CFBundleDisplayName', 'Claude Glass');
set('CFBundleIdentifier', 'dev.claude-glass.app');

// Icon: assets/icon.png → .icns replacing Electron's.
const iconset = join(tmp, 'icon.iconset');
mkdirSync(iconset);
for (const size of [16, 32, 128, 256, 512]) {
  run('sips', ['-z', String(size), String(size), 'assets/icon.png', '--out', join(iconset, `icon_${size}x${size}.png`)]);
  run('sips', ['-z', String(size * 2), String(size * 2), 'assets/icon.png', '--out', join(iconset, `icon_${size}x${size}@2x.png`)]);
}
run('iconutil', ['-c', 'icns', iconset, '-o', join(tmpApp, 'Contents', 'Resources', 'electron.icns')]);
rmSync(iconset, { recursive: true, force: true });

// Editing the bundle invalidates Electron's signature; re-sign ad hoc so macOS will run it.
run('codesign', ['--force', '--deep', '--sign', '-', tmpApp]);
try {
  renameSync(tmp, dir);
} catch {
  rmSync(tmp, { recursive: true, force: true }); // another build got there first; use theirs
}
record();
console.log(`made ${app}`);
