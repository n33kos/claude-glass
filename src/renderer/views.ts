// Renderer-side view registry. Keys match AppDef.type in src/apps/registry.ts.
import type { ComponentType } from 'react';
import { ConversationView } from '../apps/conversation/view';
import { DiffView } from '../apps/diff/view';
import { HtmlView } from '../apps/html/view';
import { ImageView } from '../apps/image/view';
import { MarkdownView } from '../apps/markdown/view';
import { SettingsView } from '../apps/settings/view';
import { TerminalView } from '../apps/terminal/view';
import type { ViewProps } from './viewTypes';

export const VIEWS: Record<string, ComponentType<ViewProps>> = {
  terminal: TerminalView,
  conversation: ConversationView,
  diff: DiffView,
  markdown: MarkdownView,
  image: ImageView,
  html: HtmlView,
  settings: SettingsView,
};
