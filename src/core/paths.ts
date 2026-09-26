// Where things live on disk. All overridable via env for tests.
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';

export function glassHome(): string {
  return process.env.CLAUDE_GLASS_HOME || join(homedir(), '.claude', 'claude-glass');
}

export function runtimeDir(): string {
  // /tmp, not $TMPDIR: macOS caps Unix socket paths at 104 bytes.
  return process.env.CLAUDE_GLASS_RUNTIME || `/tmp/claude-glass-${userInfo().uid}`;
}

export const configPath = () => join(glassHome(), 'config.json');
export const appsDir = () => join(glassHome(), 'apps');
export const sessionsDir = () => join(glassHome(), 'sessions');
export const sessionDir = (id: string) => join(sessionsDir(), id);
export const statePath = (id: string) => join(sessionDir(id), 'state.json');
export const filesDir = (id: string) => join(sessionDir(id), 'files');
export const logPath = (id: string) => join(sessionDir(id), 'glass.log');
export const socketPath = (id: string) => join(runtimeDir(), `${id}.sock`);

export function assertSessionId(id: string): string {
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(id)) throw new Error(`invalid session id: ${id}`);
  return id;
}
