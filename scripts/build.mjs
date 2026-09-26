// Bundles all entry points into dist/ with esbuild.
import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

const common = { bundle: true, sourcemap: 'inline', logLevel: 'warning', target: 'es2022' };

mkdirSync('dist', { recursive: true });
await Promise.all([
  build({ ...common, entryPoints: ['src/cli/index.ts'], outfile: 'dist/cli.js', platform: 'node', format: 'cjs', external: ['electron'] }),
  build({ ...common, entryPoints: ['src/main/index.ts'], outfile: 'dist/main.js', platform: 'node', format: 'cjs', external: ['electron'] }),
  build({ ...common, entryPoints: ['src/preload/index.ts'], outfile: 'dist/preload.js', platform: 'node', format: 'cjs', external: ['electron'] }),
  build({ ...common, entryPoints: ['src/sdk/glass-app.ts'], outfile: 'dist/sdk/glass-app.js', platform: 'browser', format: 'iife' }),
  build({ ...common, entryPoints: ['src/sdk/glass-app.css'], outfile: 'dist/sdk/glass-app.css', sourcemap: false }),
  build({ ...common, entryPoints: ['src/renderer/index.tsx'], outfile: 'dist/renderer/index.js', platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.css': 'css' } }),
]);
cpSync('src/renderer/index.html', 'dist/renderer/index.html');
console.log('built dist/');
