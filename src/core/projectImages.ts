// Images in the project folder, for the Images app's "Project" list. Plain Node: a bounded walk
// that skips dependency, build and hidden folders, newest first.
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export const IMAGE_FILE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;
const SKIP = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'target', 'vendor', 'Pods', '__pycache__', 'venv']);

export interface ProjectImage { path: string; rel: string; mtime: number; size: number }

export function findProjectImages(root: string, opts: { max?: number; depth?: number; budget?: number } = {}): ProjectImage[] {
  const max = opts.max ?? 400, depth = opts.depth ?? 8;
  let budget = opts.budget ?? 20000; // directory entries looked at, so a huge folder can't stall the glass
  const out: ProjectImage[] = [];
  const walk = (dir: string, d: number) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (--budget < 0) return;
      if (e.name.startsWith('.')) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (d < depth && !SKIP.has(e.name)) walk(p, d + 1); }
      else if (e.isFile() && IMAGE_FILE.test(e.name)) {
        try { const st = statSync(p); out.push({ path: p, rel: relative(root, p), mtime: st.mtimeMs, size: st.size }); } catch {}
      }
    }
  };
  if (root) walk(root, 0);
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, max);
}
