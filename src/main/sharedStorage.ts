// Sign-ins that follow you between glasses, for apps that opt in (permissions.sharedSignIn). Each
// glass has its own browser profile (two processes can't share one), so a page an app embeds (vmux's
// relay page, say) would start signed out in every new glass. So the glass keeps one shared copy of
// those pages' sign-in, per origin: localStorage *and* the origin's cookies, always as a pair (a
// token without its cookie looks signed in but every request is refused). It saves a pair a page
// holds, and a page missing either half gets the shared pair and reloads once.
import { type BrowserWindow, type Cookie, webFrameMain } from 'electron';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

type SavedCookie = Pick<Cookie, 'name' | 'value' | 'path' | 'httpOnly' | 'secure' | 'expirationDate' | 'sameSite'>;
type Store = Record<string, { local: Record<string, string>; cookies?: SavedCookie[]; at: number }>;

export function shareAppStorage(win: BrowserWindow, file: string, origins: () => string[]): { save: () => Promise<void>; forget: (origins: string[]) => void } {
  const read = (): Store => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; } };
  const write = (s: Store) => { mkdirSync(dirname(file), { recursive: true }); const tmp = `${file}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 }); renameSync(tmp, file); }; // sign-in tokens: owner only
  const originOf = (url: string) => origins().find((o) => url.startsWith(o + '/') || url === o);
  const cookiesOf = async (o: string): Promise<SavedCookie[]> =>
    (await win.webContents.session.cookies.get({ url: o }).catch(() => [])).map(({ name, value, path, httpOnly, secure, expirationDate, sameSite }) => ({ name, value, path, httpOnly, secure, expirationDate, sameSite }));
  const restored = new Set<string>(); // frames refilled once (by origin), so a page that clears itself isn't looped

  // Save: every opted-in frame holding a whole sign-in (storage and cookies) replaces its origin's copy.
  async function save() {
    if (win.isDestroyed()) return;
    const store = read();
    let changed = false;
    for (const f of win.webContents.mainFrame.framesInSubtree) {
      const o = originOf(f.url);
      if (!o) continue;
      const local = await f.executeJavaScript('JSON.stringify(Object.fromEntries(Object.entries(localStorage)))').then((s) => JSON.parse(String(s)) as Record<string, string>).catch(() => null);
      if (!local || !Object.keys(local).length) continue;
      const cookies = await cookiesOf(o);
      if (!cookies.length) continue; // half a sign-in: never let it replace a whole one
      if (JSON.stringify(store[o]?.local) === JSON.stringify(local) && JSON.stringify(store[o]?.cookies) === JSON.stringify(cookies)) continue;
      store[o] = { local, cookies, at: Date.now() };
      changed = true;
    }
    if (changed) write(store);
  }

  // Restore: an opted-in frame missing either half (empty storage, or no cookie) gets the whole
  // shared pair, once. A copy saved without cookies (older glasses) is never restored.
  win.webContents.on('did-frame-finish-load', (_e, isMain, processId, routingId) => {
    if (isMain) return;
    const f = webFrameMain.fromId(processId, routingId);
    const o = f && originOf(f.url);
    if (!f || !o || restored.has(o)) return;
    const copy = read()[o];
    if (!copy?.cookies?.length || !Object.keys(copy.local ?? {}).length) return;
    restored.add(o);
    void (async () => {
      const hasCookie = (await cookiesOf(o)).length > 0;
      const hasLocal = await f.executeJavaScript('localStorage.length > 0').catch(() => true);
      if (hasCookie && hasLocal) return;
      const ses = win.webContents.session;
      for (const c of copy.cookies!) await ses.cookies.set({ url: o, ...c }).catch(() => {});
      await f.executeJavaScript(`(() => { localStorage.clear(); const c = ${JSON.stringify(copy.local)};
        for (const [k, v] of Object.entries(c)) localStorage.setItem(k, v); location.reload(); })()`).catch(() => {});
    })();
  });

  return {
    save,
    forget(list) { const s = read(); let hit = false; for (const o of list) if (s[o]) { delete s[o]; hit = true; } if (hit) write(s); },
  };
}
