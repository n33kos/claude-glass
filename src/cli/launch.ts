// Spawn a detached Electron process for one session and wait until its socket answers.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { logPath, sessionDir, socketPath } from '../core/paths';
import { isLive } from '../core/server';

/** The shared Claude Glass.app this version was built against, if it's there. */
function sharedApp(): string | null {
  try {
    const { app } = JSON.parse(readFileSync(join(__dirname, 'app.json'), 'utf8')) as { app?: string };
    return app && existsSync(join(app, 'Contents', 'MacOS', 'Electron')) ? app : null;
  } catch {
    return null;
  }
}

const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
const NAMED_TTL = 30 * 24 * 3600 * 1000;

/**
 * The shared bundle under the project's name, so each glass has its own label in the dock: the
 * dock names an app by its .app folder, and only that. Its Info.plist can't change (that breaks
 * the signature, and macOS then mutes the mic without asking), a symlink resolves back to the
 * shared bundle, but an APFS clone in a folder of its own name is the same signed bundle: same
 * signature, same mic grant, next to no disk. Clones live beside the shared bundle (`named/`), so
 * a new Electron or icon, which makes a new shared bundle, starts new clones; an update that keeps
 * the bundle keeps them. Made beside their place and renamed in; touched on each use, and ones
 * unused for 30 days (and not running) go. Anything off falls back to the shared bundle.
 */
export function namedApp(shared: string, cwd: string): string {
  const name = basename(cwd).replace(/[/:]/g, '-').replace(/^\.+/, '').slice(0, 60).trim();
  if (!name || `${name}.app` === basename(shared)) return shared;
  const dir = join(dirname(shared), 'named');
  const app = join(dir, `${name}.app`);
  try {
    mkdirSync(dir, { recursive: true });
    if (!existsSync(join(app, 'Contents', 'MacOS', 'Electron'))) {
      const tmp = join(dir, `.${name}.tmp-${process.pid}.app`);
      rmSync(tmp, { recursive: true, force: true });
      execFileSync('cp', ['-Rc', shared, tmp], { stdio: 'ignore' }); // fails off APFS: no full copies
      try { renameSync(tmp, app); } catch { rmSync(tmp, { recursive: true, force: true }); } // another launch got there first
    }
    const now = new Date();
    utimesSync(app, now, now);
    pruneNamed(dir, app);
    return app;
  } catch {
    return shared;
  }
}

/** Clones not used for 30 days go, unless a glass still runs from one (or a launch is making one). */
function pruneNamed(dir: string, keep: string) {
  const old = readdirSync(dir).map((f) => join(dir, f))
    .filter((p) => p !== keep && Date.now() - statSync(p).mtimeMs > NAMED_TTL);
  if (!old.length) return;
  const running = execFileSync('ps', ['-axo', 'command='], { encoding: 'utf8' });
  for (const p of old) {
    if (running.includes(`${p}/Contents/`)) continue;
    try { execFileSync(LSREGISTER, ['-u', p], { stdio: 'ignore' }); } catch {}
    rmSync(p, { recursive: true, force: true });
  }
}

export async function launchGlass(sessionId: string, cwd: string, timeoutMs = 15000): Promise<'already' | 'started'> {
  const sock = socketPath(sessionId);
  if (await isLive(sock)) return 'already';
  mkdirSync(sessionDir(sessionId), { recursive: true });
  // macOS: prefer the renamed bundle (dock/menu say "Claude Glass"); else plain Electron. It's one
  // bundle shared by every installed version (scripts/make-app.mjs); dist/app.json names it. Each
  // glass runs it under its project's name, so the dock tells glasses apart (one in another glass
  // home, a test's or a demo's, stays out of the dock and runs the shared one).
  const shared = sharedApp();
  const bundle = shared && !process.env.CLAUDE_GLASS_HOME ? namedApp(shared, cwd) : shared;
  const packaged = bundle ? join(bundle, 'Contents', 'MacOS', 'Electron') : '';
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const electronBin: string = bundle ? packaged : require('electron');
  const mainJs = join(__dirname, 'main.js');
  const log = openSync(logPath(sessionId), 'a');
  const args = [mainJs, '--session', sessionId, '--cwd', cwd];
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  if (bundle) {
    // macOS: launch through LaunchServices (`open`), not as our child. Claude often runs inside
    // tmux (or a daemon), whose processes sit outside the user's GUI session: an app spawned from
    // there gets windows but no dock icon, no ⌘Tab, and System Events can't see it. `open` starts it
    // in the GUI session like any app. It gets launchd's environment, so pass on what the glass reads.
    const pass = ['CLAUDE_GLASS_HOME', 'CLAUDE_GLASS_RUNTIME', 'CLAUDE_GLASS_DEBUG_PORT', 'CLAUDE_GLASS_HIDDEN']
      .filter((k) => process.env[k] !== undefined).flatMap((k) => ['--env', `${k}=${process.env[k]}`]);
    // `open` also hands the app our own environment: never ELECTRON_RUN_AS_NODE, which a glass sets
    // to run this CLI when it restarts into a new version, or the new glass starts as plain Node.
    const out = logPath(sessionId);
    spawn('/usr/bin/open', ['-n', '-a', bundle, '--stdout', out, '--stderr', out, ...pass, '--args', ...args], { detached: true, stdio: 'ignore', env }).unref();
  } else {
    spawn(electronBin, args, { detached: true, stdio: ['ignore', log, log], env }).unref();
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    if (await isLive(sock)) return 'started';
  }
  throw new Error(`Claude Glass did not start within ${timeoutMs}ms; see ${logPath(sessionId)}`);
}
