// Sign-ins that follow you between glasses. Each glass has its own browser profile (two processes
// can't share one), so a page an app embeds (vmux's relay page, say) would start signed out in every
// new glass. So the glass keeps one shared copy of those pages' localStorage, per origin: it saves
// what a page holds (never an empty one over a full one), and a page that loads empty gets the
// shared copy and reloads once. Only origins an app's manifest declares (permissions.network).
import { type BrowserWindow, webFrameMain } from 'electron';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

type Store = Record<string, { local: Record<string, string>; at: number }>;

export function shareAppStorage(win: BrowserWindow, file: string, origins: () => string[]): { save: () => Promise<void>; forget: (origins: string[]) => void } {
  const read = (): Store => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; } };
  const write = (s: Store) => { mkdirSync(dirname(file), { recursive: true }); const tmp = `${file}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 }); renameSync(tmp, file); }; // sign-in tokens: owner only
  const originOf = (url: string) => origins().find((o) => url.startsWith(o + '/') || url === o);
  const restored = new Set<string>(); // frames refilled once (by origin), so a page that clears itself isn't looped

  // Save: every declared-origin frame that holds something replaces its origin's copy.
  async function save() {
    if (win.isDestroyed()) return;
    const store = read();
    let changed = false;
    for (const f of win.webContents.mainFrame.framesInSubtree) {
      const o = originOf(f.url);
      if (!o) continue;
      const local = await f.executeJavaScript('JSON.stringify(Object.fromEntries(Object.entries(localStorage)))').then((s) => JSON.parse(String(s)) as Record<string, string>).catch(() => null);
      if (!local || !Object.keys(local).length) continue;
      if (JSON.stringify(store[o]?.local) === JSON.stringify(local)) continue;
      store[o] = { local, at: Date.now() };
      changed = true;
    }
    if (changed) write(store);
  }

  // Restore: a declared-origin frame that loads with empty storage gets the shared copy, once.
  win.webContents.on('did-frame-finish-load', (_e, isMain, processId, routingId) => {
    if (isMain) return;
    const f = webFrameMain.fromId(processId, routingId);
    const o = f && originOf(f.url);
    if (!f || !o || restored.has(o)) return;
    const copy = read()[o]?.local;
    if (!copy || !Object.keys(copy).length) return;
    restored.add(o);
    void f.executeJavaScript(`(() => { if (localStorage.length) return false; const c = ${JSON.stringify(copy)};
      for (const [k, v] of Object.entries(c)) localStorage.setItem(k, v); location.reload(); return true; })()`).catch(() => {});
  });

  return {
    save,
    forget(list) { const s = read(); let hit = false; for (const o of list) if (s[o]) { delete s[o]; hit = true; } if (hit) write(s); },
  };
}
