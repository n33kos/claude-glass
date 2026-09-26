// Renderer-side view registry. Keys match AppDef.type in src/apps/registry.ts.
import type { ComponentType } from 'react';
import { BrowserView } from '../apps/browser/view';
import { SettingsView } from '../apps/settings/view';
import type { ViewProps } from './viewTypes';

export const VIEWS: Record<string, ComponentType<ViewProps>> = {
  browser: BrowserView,
  settings: SettingsView,
};
