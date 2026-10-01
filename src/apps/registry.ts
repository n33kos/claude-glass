// The app registry. Built-in apps and the user's custom apps register the same way (`registerApp`); a user
// mod with a built-in's type replaces it. Views: see src/renderer/views.ts (built-in, native)
// and the mod frame (apps with `dir`).
import type { AppDef } from './types';
import { terminal } from './terminal';
import { conversation } from './conversation';
import { diff } from './diff';
import { markdown } from './markdown';
import { image } from './image';
import { html } from './html';
import { settings } from './settings';
import { browser } from './browser';
import { tasks } from './tasks';
import { agents } from './agents';
import { tests } from './tests';
import { files } from './files';
import { diagram } from './diagram';
import { action } from './action';

export const APPS: Record<string, AppDef> = {};

export function registerApp(app: AppDef): void {
  APPS[app.type] = app;
}

for (const app of [terminal, conversation, diff, markdown, image, html, browser, tasks, agents, tests, files, diagram, action, settings]) registerApp({ ...app, source: 'builtin' });

// Commands used only by hooks/UI; hidden from the catalog Claude sees.
export const INTERNAL_COMMANDS = new Set(['tool.start', 'tool.end', 'agent', 'filter', 'user', 'chunk', 'turnEnd', 'status', 'web.search', 'web.page', 'web.title', 'web.go', 'web.found', 'web.away', 'web.home']);

export const isInternal = (app: AppDef, cmd: string) => INTERNAL_COMMANDS.has(cmd) || !!app.internal?.includes(cmd);

export function getApp(type: string): AppDef {
  const app = APPS[type];
  if (!app) throw new Error(`unknown app type "${type}" (known: ${Object.keys(APPS).join(', ')})`);
  return app;
}
