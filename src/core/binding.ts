// Which glass a Claude session feeds. `scope: session` → the glass id is the session id.
// `scope: folder` → every session in a project folder shares one glass, id = sha256(dir)[:12]
// (the same id Voice Multiplexer uses for its relay sessions). The binding is a symlink
// <runtime>/<session_id>.sock → <glass id>.sock, so everything that addresses sockets by session
// id (hook forwarder, CLI) follows it with no lookup.
//
// Lifecycle rules: a glass's own socket is a real socket file, created when it starts and removed
// when it quits. Links are only ever made for Claude session ids, never over a real socket, and
// anything a dead glass left behind (a socket nobody listens on, a link to a missing glass) is
// cleared by cleanupRuntime before sockets are used.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs';
import net from 'node:net';
import { basename, dirname, join } from 'node:path';
import { runtimeDir, socketPath } from './paths';
import type { GlobalConfig } from './types';

export function folderGlassId(dir: string): string {
  return createHash('sha256').update(dir.replace(/\/+$/, '') || '/').digest('hex').slice(0, 12);
}

/** Folder glass ids are 12 hex characters; Claude session ids are UUIDs. */
export const isFolderGlassId = (id: string) => /^[0-9a-f]{12}$/.test(id);

/** A real socket (a glass's own), as opposed to a session's link to one. */
export function isOwnSocket(id: string): boolean {
  try { return lstatSync(socketPath(id)).isSocket(); } catch { return false; }
}

/** True only when nothing is listening (connection refused / gone). A slow or busy glass is not dead. */
function socketDead(path: string, timeoutMs = 400): Promise<boolean> {
  return new Promise((res) => {
    const sock = net.connect(path);
    const t = setTimeout(() => { sock.destroy(); res(false); }, timeoutMs);
    sock.on('connect', () => { clearTimeout(t); sock.destroy(); res(false); });
    sock.on('error', (e: NodeJS.ErrnoException) => { clearTimeout(t); res(e.code === 'ECONNREFUSED' || e.code === 'ENOENT'); });
  });
}

/**
 * Clear what dead glasses leave behind (a crash, a kill, a plugin update removing the running
 * version): sockets nobody listens on, then session links whose glass socket is gone.
 * Live glasses and links to them are never touched. Returns the names removed.
 */
export async function cleanupRuntime(): Promise<string[]> {
  const dir = runtimeDir();
  let names: string[];
  try { names = readdirSync(dir).filter((n) => n.endsWith('.sock')); } catch { return []; }
  const removed: string[] = [];
  const drop = (n: string) => { try { unlinkSync(join(dir, n)); removed.push(n); } catch {} };
  const links: string[] = [];
  await Promise.all(names.map(async (n) => {
    let st;
    try { st = lstatSync(join(dir, n)); } catch { return; }
    if (st.isSymbolicLink()) links.push(n);
    else if (st.isSocket() && (await socketDead(join(dir, n)))) drop(n);
  }));
  for (const n of links) if (!existsSync(join(dir, n))) drop(n); // existsSync follows the link
  return removed;
}

/** The glass a session is bound to: the symlink target, or the session id itself. */
export function glassIdFor(sessionId: string): string {
  try {
    const target = readlinkSync(socketPath(sessionId));
    return basename(target).replace(/\.sock$/, '');
  } catch {
    return sessionId;
  }
}

export function isBound(sessionId: string): boolean {
  try { return lstatSync(socketPath(sessionId)).isSymbolicLink(); } catch { return false; }
}

/** Bind (folder scope) or unbind (session scope) a session. Returns the glass id to use. */
export function bindSession(sessionId: string, projectDir: string, scope: GlobalConfig['scope']): string {
  const link = socketPath(sessionId);
  // A glass id is a glass, not a session: never turn it into a link to another glass.
  if (isFolderGlassId(sessionId)) return sessionId;
  // Never replace a real socket: that's a glass running under this id (run cleanupRuntime first
  // so a dead one's leftover socket is already gone).
  if (isOwnSocket(sessionId)) return sessionId;
  if (scope !== 'folder' || !projectDir) {
    // A link to another session's glass is the conversation that glass followed through /clear
    // (followSession): it stays while that glass is open. A link to a folder glass goes.
    if (isBound(sessionId)) {
      const glassId = glassIdFor(sessionId);
      if (!isFolderGlassId(glassId) && existsSync(link)) return glassId;
      try { unlinkSync(link); } catch {}
    }
    return sessionId;
  }
  return linkTo(sessionId, folderGlassId(projectDir));
}

/** Point a session's socket at a glass (never over a real socket); the glass id. */
function linkTo(sessionId: string, glassId: string): string {
  if (glassId === sessionId) return glassId;
  const link = socketPath(sessionId);
  const target = `${glassId}.sock`;
  try { if (readlinkSync(link) === target) return glassId; } catch {}
  mkdirSync(dirname(link), { recursive: true, mode: 0o700 });
  try { unlinkSync(link); } catch {}
  symlinkSync(target, link);
  return glassId;
}

/**
 * /clear gives the conversation a new session id. In session scope the glass belongs to the old
 * one, so the new id follows it there (a link), while it's open. Returns the glass id, or null
 * when there's no open glass to follow (or the new id has a glass of its own).
 */
export function followSession(sessionId: string, previous: string): string | null {
  if (!previous || previous === sessionId || isFolderGlassId(sessionId) || isOwnSocket(sessionId)) return null;
  const glassId = glassIdFor(previous);
  if (isFolderGlassId(glassId) || !existsSync(socketPath(glassId))) return null;
  return linkTo(sessionId, glassId);
}
