// Bundles all entry points into dist/ with esbuild.
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const common = { bundle: true, sourcemap: 'inline', logLevel: 'warning', target: 'es2022' };
const require = createRequire(import.meta.url);

// Built-in apps that ship in the mod format (the rest still have native views; see PLAN §8).
const FRAME_APPS = ['image', 'markdown', 'html', 'diff', 'conversation', 'terminal', 'browser'];
// Kept in sync with INTERNAL_COMMANDS in src/apps/registry.ts (hidden from Claude's catalog).
const INTERNAL = new Set(['tool.start', 'tool.end', 'agent', 'filter', 'user', 'chunk', 'turnEnd', 'status', 'web.search', 'web.page', 'web.title', 'web.go']);

mkdirSync('dist', { recursive: true });
await Promise.all([
  build({ ...common, entryPoints: ['src/cli/index.ts'], outfile: 'dist/cli.js', platform: 'node', format: 'cjs', external: ['electron'] }),
  build({ ...common, entryPoints: ['src/main/index.ts'], outfile: 'dist/main.js', platform: 'node', format: 'cjs', external: ['electron'] }),
  build({ ...common, entryPoints: ['src/preload/index.ts'], outfile: 'dist/preload.js', platform: 'node', format: 'cjs', external: ['electron'] }),
  build({ ...common, entryPoints: ['src/sdk/glass-app.ts'], outfile: 'dist/sdk/glass-app.js', platform: 'browser', format: 'iife' }),
  build({ ...common, entryPoints: ['src/sdk/glass-app.css'], outfile: 'dist/sdk/glass-app.css', sourcemap: false }),
  build({ ...common, entryPoints: ['src/renderer/index.tsx'], outfile: 'dist/renderer/index.js', platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.css': 'css' } }),
  ...FRAME_APPS.map(buildApp),
]);
cpSync('src/renderer/index.html', 'dist/renderer/index.html');
console.log('built dist/');

/** src/apps/<type>/ → dist/apps/<type>/: a complete mod folder (core.js, glass-app.json, view.*, guide.md). */
async function buildApp(type) {
  const src = resolve('src/apps', type);
  const out = resolve('dist/apps', type);
  mkdirSync(out, { recursive: true });
  const view = existsSync(`${src}/view.css`);
  await Promise.all([
    build({ ...common, sourcemap: false, stdin: { contents: `module.exports = require(${JSON.stringify(src + '/index.ts')}).default;`, resolveDir: src, loader: 'js' },
      outfile: `${out}/core.js`, platform: 'node', format: 'cjs' }),
    build({ ...common, stdin: { contents: `import { mount } from ${JSON.stringify(resolve('src/sdk/react.tsx'))}; import View from ${JSON.stringify(src + '/view.tsx')}; mount(View);`, resolveDir: src, loader: 'tsx' },
      outfile: `${out}/view.js`, platform: 'browser', format: 'iife', jsx: 'automatic' }),
    view && build({ ...common, sourcemap: false, entryPoints: [`${src}/view.css`], outfile: `${out}/view.css` }),
  ]);
  const def = require(`${out}/core.js`);
  const commands = Object.fromEntries(Object.entries(def.commands).map(([k, c]) => [k, { usage: c.usage, help: c.help, ...(c.view ? { view: true } : {}) }]));
  const manifest = {
    apiVersion: 1, type: def.type, title: def.title, icon: def.icon, singleton: def.singleton, description: def.description, commands,
    ...(def.viewCommands ? { viewCommands: def.viewCommands } : {}),
    internal: [...INTERNAL].filter((c) => c in def.commands || def.viewCommands?.includes(c)),
    ...(def.autoOpen ? { autoOpen: true } : {}),
  };
  writeFileSync(`${out}/glass-app.json`, JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(`${out}/view.html`, `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<link rel="stylesheet" href="glass-app://sdk/glass-app.css">
${view ? `<link rel="stylesheet" href="view.css">\n` : ''}</head>
<body>
<script src="view.js"></script>
</body>
</html>
`);
  if (existsSync(`${src}/guide.md`)) cpSync(`${src}/guide.md`, `${out}/guide.md`);
  // The TypeScript sources ride along for reference when someone copies a built-in.
  cpSync(src, `${out}/src`, { recursive: true });
}
