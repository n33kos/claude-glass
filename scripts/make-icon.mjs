// Renders assets/icon.svg → assets/icon.png (transparent) using Electron via Playwright.
import { readFileSync, writeFileSync } from 'node:fs';
import { _electron as electron } from 'playwright';
const svg = readFileSync('assets/icon.svg', 'utf8');
writeFileSync('/tmp/cc-icon-main.cjs', `const { app, BrowserWindow } = require('electron');
app.whenReady().then(() => { const w = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false }); w.loadURL('about:blank'); });`);
const app = await electron.launch({ args: ['/tmp/cc-icon-main.cjs'] });
const page = await app.firstWindow();
await page.setViewportSize({ width: 1024, height: 1024 });
await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
await page.locator('svg').screenshot({ path: 'assets/icon.png', omitBackground: true });
await app.close();
console.log('wrote assets/icon.png');
