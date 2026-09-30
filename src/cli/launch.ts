// Spawn a detached Electron process for one session and wait until its socket answers.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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

export async function launchGlass(sessionId: string, cwd: string, timeoutMs = 15000): Promise<'already' | 'started'> {
  const sock = socketPath(sessionId);
  if (await isLive(sock)) return 'already';
  mkdirSync(sessionDir(sessionId), { recursive: true });
  // macOS: prefer the renamed bundle (dock/menu say "Claude Glass"); else plain Electron. It's one
  // bundle shared by every installed version (scripts/make-app.mjs); dist/app.json names it.
  const bundle = sharedApp();
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
