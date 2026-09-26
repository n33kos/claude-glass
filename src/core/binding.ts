// Which glass a Claude session feeds. `scope: session` → the glass id is the session id.
// `scope: folder` → every session in a project folder shares one glass, id = sha256(dir)[:12]
// (the same id Voice Multiplexer uses for its relay sessions). The binding is a symlink
// <runtime>/<session_id>.sock → <glass id>.sock, so everything that addresses sockets by session
// id (hook forwarder, CLI) follows it with no lookup.
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { socketPath } from './paths';
import type { GlobalConfig } from './types';

export function folderGlassId(dir: string): string {
  return createHash('sha256').update(dir.replace(/\/+$/, '') || '/').digest('hex').slice(0, 12);
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
  if (scope !== 'folder' || !projectDir) {
    if (isBound(sessionId)) try { unlinkSync(link); } catch {}
    return sessionId;
  }
  const glassId = folderGlassId(projectDir);
  if (glassId === sessionId) return glassId;
  const target = `${glassId}.sock`;
  try { if (readlinkSync(link) === target) return glassId; } catch {}
  mkdirSync(dirname(link), { recursive: true, mode: 0o700 });
  try { unlinkSync(link); } catch {}
  symlinkSync(target, link);
  return glassId;
}
