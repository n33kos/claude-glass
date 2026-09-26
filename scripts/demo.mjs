// Open a real glass window with demo content: node scripts/demo.mjs [session-id]
// Uses a throwaway home unless CLAUDE_GLASS_HOME is set.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cli, seed } from '../test/e2e/seed.mjs';

const SID = process.argv[2] || `demo-${Date.now()}`;
const env = {
  ...process.env,
  CLAUDE_GLASS_HOME: process.env.CLAUDE_GLASS_HOME || mkdtempSync(join(tmpdir(), 'cc-demo-')),
  CLAUDE_CODE_SESSION_ID: SID,
};
console.log(await cli(env, 'open').then((o) => o.split('\n')[0]));
await seed(env);
console.log(await cli(env, 'view'));
console.log(`\nClose with: CLAUDE_GLASS_HOME=${env.CLAUDE_GLASS_HOME} claude-glass close --session ${SID}`);
