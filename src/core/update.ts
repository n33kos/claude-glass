// Has Claude Glass been updated under a running glass? Claude Code's plugin install record
// (installed_plugins.json) names the folder of the version installed now; a glass running from
// another version's folder (in the plugin cache) is out of date. A glass run from a checkout (dev)
// never is. Plain Node, so tests can drive it.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

export interface Installed { version: string; root: string }

export const pluginsDir = () => join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'plugins');

/** The installed Claude Glass plugin (user scope first), or null. */
export function installedGlass(dir = pluginsDir()): Installed | null {
  try {
    const j = JSON.parse(readFileSync(join(dir, 'installed_plugins.json'), 'utf8'));
    const all = j.plugins ?? j;
    const entries = Object.entries(all).filter(([k]) => k.startsWith('claude-glass@')).flatMap(([, v]) => (Array.isArray(v) ? v : [v])) as { scope?: string; installPath?: string; version?: string }[];
    const e = entries.find((x) => x.scope === 'user') ?? entries[0];
    return e?.installPath && e.version ? { version: String(e.version), root: resolve(e.installPath) } : null;
  } catch {
    return null;
  }
}

const isPluginInstall = (root: string, dir: string) => resolve(root).startsWith(join(dir, 'cache') + sep);

/** The version this glass runs (from `ownRoot`'s package.json); `dev` when it's a checkout. */
export function ownVersion(ownRoot: string, dir = pluginsDir()): { version: string; dev: boolean } {
  let version = '?';
  try { version = String(JSON.parse(readFileSync(join(ownRoot, 'package.json'), 'utf8')).version ?? '?'); } catch {}
  return { version, dev: !isPluginInstall(ownRoot, dir) };
}

/** The version to move to, if this glass (running from `ownRoot`) is an older plugin install. */
export function pendingUpdate(ownRoot: string, dir = pluginsDir()): Installed | null {
  const own = resolve(ownRoot);
  if (!isPluginInstall(own, dir)) return null; // a checkout, not a plugin install
  const now = installedGlass(dir);
  if (!now || now.root === own || !existsSync(join(now.root, 'bin', 'claude-glass'))) return null;
  return now;
}
