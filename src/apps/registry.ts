// Core-side app registry. Add new apps here (and their view in src/renderer/views.ts).
import type { AppDef } from './types';
import { terminal } from './terminal';
import { conversation } from './conversation';
import { diff } from './diff';
import { markdown } from './markdown';
import { image } from './image';
import { html } from './html';
import { settings } from './settings';
import { browser } from './browser';

export const APPS: Record<string, AppDef> = Object.fromEntries(
  [terminal, conversation, diff, markdown, image, html, browser, settings].map((a) => [a.type, a]),
);

// Commands used only by hooks/UI; hidden from the catalog Claude sees.
export const INTERNAL_COMMANDS = new Set(['tool.start', 'tool.end', 'agent', 'filter', 'user', 'chunk', 'turnEnd', 'status', 'web.search', 'web.page', 'web.title', 'web.go']);

export function getApp(type: string): AppDef {
  const app = APPS[type];
  if (!app) throw new Error(`unknown app type "${type}" (known: ${Object.keys(APPS).join(', ')})`);
  return app;
}
