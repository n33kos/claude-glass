// Core data model. Pure types, shared by core, main, renderer, and CLI.

export type Edge = 'left' | 'right' | 'top' | 'bottom';

export type LayoutName = 'full' | 'split' | 'main-left' | 'main-left-nest' | 'columns' | 'grid' | 'nested';

export interface InstanceMeta {
  id: string;
  type: string;
  title: string;
  createdAt: number;
  opacity?: number;
}

export interface SessionInfo {
  id: string;
  cwd: string;
  title: string;
  startedAt: number;
  endedAt?: number;
  activity: 'idle' | 'working';
  waiting?: Waiting; // Claude is blocked on the user (shown read-only; answered in Claude Code)
}

export interface Waiting {
  kind: 'question' | 'permission';
  summary: string;
  tool?: string;
  toolUseId?: string;
  questions?: { question: string; header?: string; options: { label: string; description?: string }[] }[];
  since: number;
}

export interface SessionSettings {
  windowMode?: 'live' | 'history'; // history = a new window for every edit, plan, image, search and page
  historyLimit?: number; // history mode keeps this many history windows (default 12); older ones are deleted
  autoOpen: { changes: boolean; plan: boolean; images: boolean; web?: boolean }; // web: absent = on
  windowOpacity?: number;
  backgroundColors?: string[]; // Claude's signal: this glass's wallpaper light (hex), over the user's
}

export interface GlobalConfig {
  autoStart: boolean;
  background: string; // preset name or absolute image path
  backgroundColors: string[]; // the user's own wallpaper light colors (hex); empty = the preset's
  defaultLayout: LayoutName | 'claude'; // claude: new desktops fit their window count; Claude picks layouts
  windowOpacity: number;
  dockAutoHide: boolean; // dock overlays and hides; windows get its space
  dockOrder: 'windows' | 'fixed'; // windows: follow tile order, closed apps after; fixed: by app type
  waitingGlow: boolean; // faint amber edge glow while Claude waits on the user
  animateBackground: boolean; // preset wallpapers drift slowly
  wheelDesktops: boolean; // vertical scroll outside any window switches desktops
  disabledApps: string[]; // app types the user turned off: hidden, and their commands refused
  scope: 'session' | 'folder'; // one glass per session, or one per project folder shared by its sessions
  nestedView: boolean; // one screen: newest window big, older ones spiral into smaller panes
  toolReminders: boolean; // remind Claude to use Read/Edit/Write when a Bash command did file I/O (scripts/tool-reminder.sh)
}

export interface GlassState {
  version: 1;
  session: SessionInfo;
  order: string[];
  desktops: LayoutName[];
  instances: Record<string, InstanceMeta>;
  appState: Record<string, unknown>;
  settings: SessionSettings;
  ui: { viewingDesktop: number };
  // Instances the hooks auto-opened once; never auto-reopened after the user closes them.
  autoOpened: string[];
  // Windows pinned to an edge sidebar (shown to users as "pin"; stored as "tucked"): out of the
  // tiling flow, on every desktop, shown on hover or kept open.
  tucked?: Partial<Record<Edge, string[]>>;
  // Edges whose panel stays open; the layout makes room for them (like a docked sidebar).
  tuckKeep?: Edge[];
  // Sidebar sizes the user dragged (px: width for left/right, height for top/bottom).
  tuckSize?: Partial<Record<Edge, number>>;
}

export type Action =
  | { type: 'window.open'; id: string }
  | { type: 'window.close'; id: string }
  | { type: 'window.move'; id: string; index: number }
  | { type: 'window.opacity'; id: string; value: number | null }
  | { type: 'desktop.layout'; desktop: number; layout: LayoutName }
  | { type: 'instance.create'; appType: string; id?: string; title?: string; open?: boolean }
  | { type: 'instance.rename'; id: string; title: string }
  | { type: 'app.command'; id: string; command: string; args?: Record<string, unknown> }
  | { type: 'settings.set'; key: string; value: unknown }
  | { type: 'session.update'; patch: Partial<SessionInfo> }
  | { type: 'ui.viewDesktop'; index: number }
  | { type: 'app.hook'; payload: unknown }
  | { type: 'window.tuck'; id: string; edge: Edge; index?: number } // index: position in the sidebar (default last)
  | { type: 'window.untuck'; id: string; index?: number } // index: slot in the layout (default 0)
  | { type: 'instance.delete'; id: string } // remove a window and its state entirely
  | { type: 'tuck.keep'; edge: Edge; keep: boolean }
  | { type: 'tuck.size'; edge: Edge; size: number };

export interface Envelope {
  op: 'ping' | 'hook' | 'dispatch' | 'view' | 'state' | 'catalog' | 'guide' | 'mods' | 'config' | 'quit';
  [k: string]: unknown;
}

export interface Reply {
  ok: boolean;
  result?: unknown;
  error?: string;
}
