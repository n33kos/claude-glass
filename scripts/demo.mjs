// Open a real canvas window with demo content: node scripts/demo.mjs [session-id]
// Uses a throwaway home unless CLAUDE_CANVAS_HOME is set.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cli, seed } from '../test/e2e/seed.mjs';

const SID = process.argv[2] || `demo-${Date.now()}`;
const env = {
  ...process.env,
  CLAUDE_CANVAS_HOME: process.env.CLAUDE_CANVAS_HOME || mkdtempSync(join(tmpdir(), 'cc-demo-')),
  CLAUDE_CODE_SESSION_ID: SID,
};
console.log(await cli(env, 'open').then((o) => o.split('\n')[0]));
await seed(env);
console.log(await cli(env, 'view'));
console.log(`\nClose with: CLAUDE_CANVAS_HOME=${env.CLAUDE_CANVAS_HOME} claude-canvas close --session ${SID}`);
