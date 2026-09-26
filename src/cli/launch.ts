// Spawn a detached Electron process for one session and wait until its socket answers.
import { spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { logPath, sessionDir, socketPath } from '../core/paths';
import { isLive } from '../core/server';

export async function launchCanvas(sessionId: string, cwd: string, timeoutMs = 15000): Promise<'already' | 'started'> {
  const sock = socketPath(sessionId);
  if (await isLive(sock)) return 'already';
  mkdirSync(sessionDir(sessionId), { recursive: true });
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const electronBin: string = require('electron');
  const mainJs = join(__dirname, 'main.js');
  const log = openSync(logPath(sessionId), 'a');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBin, [mainJs, '--session', sessionId, '--cwd', cwd], {
    detached: true, stdio: ['ignore', log, log], env,
  });
  child.unref();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    if (await isLive(sock)) return 'started';
  }
  throw new Error(`canvas did not start within ${timeoutMs}ms; see ${logPath(sessionId)}`);
}
