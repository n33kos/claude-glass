// macOS: make dist/Claude Glass.app, a renamed copy of Electron.app, so the dock and menu bar say
// "Claude Glass" with our icon. APFS clone (cp -c): instant, no extra disk. Skipped when current.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

if (process.platform !== 'darwin') process.exit(0);

const require = createRequire(import.meta.url);
const electronVersion = require('electron/package.json').version;
const src = 'node_modules/electron/dist/Electron.app';
const app = 'dist/Claude Glass.app';
const stampPath = 'dist/.app-stamp.json'; // outside the bundle: files inside must stay signed
const stamp = JSON.stringify({ electronVersion, icon: statSync('assets/icon.png').mtimeMs });

const run = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'inherit'] });
// Newer npm versions can skip install scripts, including the one that downloads Electron itself.
if (!existsSync(src)) run(process.execPath, ['node_modules/electron/install.js']);

if (existsSync(stampPath) && readFileSync(stampPath, 'utf8') === stamp && existsSync(app)) process.exit(0);
rmSync(app, { recursive: true, force: true });
mkdirSync('dist', { recursive: true });
run('cp', ['-Rc', src, app]);

// Name and identity.
const plist = join(app, 'Contents', 'Info.plist');
const set = (key, value) => run('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]);
set('CFBundleName', 'Claude Glass');
set('CFBundleDisplayName', 'Claude Glass');
set('CFBundleIdentifier', 'dev.claude-glass.app');

// Icon: assets/icon.png → .icns replacing Electron's.
const iconset = join('dist', 'icon.iconset');
rmSync(iconset, { recursive: true, force: true });
mkdirSync(iconset);
for (const size of [16, 32, 128, 256, 512]) {
  run('sips', ['-z', String(size), String(size), 'assets/icon.png', '--out', join(iconset, `icon_${size}x${size}.png`)]);
  run('sips', ['-z', String(size * 2), String(size * 2), 'assets/icon.png', '--out', join(iconset, `icon_${size}x${size}@2x.png`)]);
}
run('iconutil', ['-c', 'icns', iconset, '-o', join(app, 'Contents', 'Resources', 'electron.icns')]);
rmSync(iconset, { recursive: true, force: true });

// Editing the bundle invalidates Electron's signature; re-sign ad hoc so macOS will run it.
run('codesign', ['--force', '--deep', '--sign', '-', app]);
writeFileSync(stampPath, stamp);
console.log(`made ${app}`);
