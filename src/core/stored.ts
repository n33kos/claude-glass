// Apps' persistent values on disk. Session-scoped values live in the glass's state.json like the
// rest of its state; project- and global-scoped ones each have a file per app, shared by every
// glass that reads them:
//   ~/.claude/claude-glass/stored/<type>.json                          global
//   ~/.claude/claude-glass/projects/<folder id>/stored/<type>.json     project (folder id = sha256(dir)[:12])
// The reducer owns the values (stored.set / stored.load); this only mirrors them to files and
// loads what other glasses write. Last write wins per file.
import { existsSync, mkdirSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { APPS } from '../apps/registry';
import type { AppDef, StoredScope } from '../apps/types';
import { folderGlassId } from './binding';
import { writeJsonAtomic } from './config';
import { glassHome } from './paths';
import type { Action, GlassState } from './types';

type FileScope = Exclude<StoredScope, 'session'>;
const RECHECK_MS = 2000;

export function storedDir(scope: FileScope, cwd: string): string {
  return scope === 'global' ? join(glassHome(), 'stored') : join(glassHome(), 'projects', folderGlassId(cwd || '/'), 'stored');
}

export const storedFile = (scope: FileScope, type: string, cwd: string) => join(storedDir(scope, cwd), `${type}.json`);

function readJson(path: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

/** The values of one scope, out of an app's stored values. */
function scoped(app: AppDef, values: Record<string, unknown> | undefined, scope: FileScope): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values ?? {}).filter(([k]) => app.stored?.[k]?.scope === scope));
}

const appsWith = (scope: FileScope) => Object.values(APPS).filter((a) => Object.values(a.stored ?? {}).some((s) => s.scope === scope));

export class StoredFiles {
  private written = new Map<string, string>(); // path → the JSON this glass last wrote or read there
  private watchers: FSWatcher[] = [];

  constructor(private getState: () => GlassState, private dispatch: (a: Action) => void) {}

  private cwd() { return this.getState().session.cwd; }

  /** Load every app's project and global values into state (a glass opening). */
  load(): void {
    for (const scope of ['project', 'global'] as const) {
      for (const app of appsWith(scope)) this.loadFile(scope, app);
    }
  }

  private loadFile(scope: FileScope, app: AppDef): void {
    const path = storedFile(scope, app.type, this.cwd());
    const values = readJson(path);
    if (!values) return;
    this.written.set(path, JSON.stringify(values));
    // Every key of this scope: the file's value, or undefined (back to the default) when it has none.
    const keys = Object.entries(app.stored ?? {}).filter(([, s]) => s.scope === scope).map(([k]) => k);
    this.dispatch({ type: 'stored.load', app: app.type, values: Object.fromEntries(keys.map((k) => [k, k in values ? values[k] : undefined])) });
  }

  /** Write the files whose values changed between two states. */
  sync(prev: GlassState, next: GlassState): void {
    if (prev.stored === next.stored) return;
    const types = new Set([...Object.keys(prev.stored ?? {}), ...Object.keys(next.stored ?? {})]);
    for (const type of types) {
      if (prev.stored?.[type] === next.stored?.[type]) continue;
      const app = APPS[type];
      if (!app?.stored) continue;
      for (const scope of ['project', 'global'] as const) {
        const before = scoped(app, prev.stored?.[type], scope), after = scoped(app, next.stored?.[type], scope);
        const json = JSON.stringify(after);
        if (json === JSON.stringify(before)) continue;
        const path = storedFile(scope, type, next.session.cwd);
        if (this.written.get(path) === json) continue; // it came from that file
        try { writeJsonAtomic(path, after); this.written.set(path, json); } catch { /* a full disk never breaks the glass */ }
      }
    }
  }

  /**
   * Follow other glasses' writes to the files this glass uses: a folder watch for speed, and a
   * recheck every few seconds, since a watch can miss changes (right after it starts, on macOS).
   */
  watch(): void {
    const scopes = (['project', 'global'] as const).filter((scope) => appsWith(scope).length);
    for (const scope of scopes) {
      const dir = storedDir(scope, this.cwd());
      try {
        mkdirSync(dir, { recursive: true });
        // An atomic write's events can name the temporary file, so look at every app's file.
        this.watchers.push(watch(dir, () => this.recheck(scope)));
      } catch { /* the recheck still follows changes */ }
    }
    if (scopes.length) {
      this.timer = setInterval(() => { for (const scope of scopes) this.recheck(scope); }, RECHECK_MS);
      this.timer.unref?.();
    }
  }

  private recheck(scope: FileScope): void {
    for (const app of appsWith(scope)) {
      const path = storedFile(scope, app.type, this.cwd());
      if (!existsSync(path)) continue;
      const now = readJson(path);
      if (!now || this.written.get(path) === JSON.stringify(now)) continue; // unchanged, or our own write
      this.loadFile(scope, app);
    }
  }

  close(): void {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private timer: NodeJS.Timeout | null = null;
}
