import { type AppDef, unknownCommand } from '../types';

// Settings has no state of its own: it edits session settings (state.settings) and the global
// config through reducer actions / the config op.
export const settings: AppDef<Record<string, never>> = {
  type: 'settings',
  title: 'Settings',
  icon: '⚙',
  singleton: true,
  description: 'Global and per-session glass settings (for the user).',
  commands: {},
  init: () => ({}),
  command: (_s, cmd) => unknownCommand('settings', cmd),
};
