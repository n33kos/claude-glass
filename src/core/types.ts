// Core data model. Pure types, shared by core, main, renderer, and CLI.

export type Edge = 'left' | 'right' | 'top' | 'bottom';
export type Corner = 'top-left' | 'top-right' | 'bottom-right' | 'bottom-left';
/** A dock: somewhere a window can be docked, out of the tiling flow. One per edge and corner. */
export type Dock = Edge | Corner;

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

/** A signal Claude sends through the wallpaper light (docs/design.md, "The signal layer"). */
export interface Signal {
  kind: 'spotlight' | 'alert' | 'progress';
  target?: string; // a window id (spotlight, alert)
  value?: number; // progress, 0..1 (1 = finished: it clears)
  label?: string; // progress: what's underway
  at: number;
  seq: number;
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
  stateColors: boolean; // recolor the light from session state (working/waiting/idle/ended)
  statePalettes: Record<'working' | 'waiting' | 'idle' | 'ended', string[]>; // per state; empty = own colors
  defaultLayout: LayoutName | 'claude'; // claude: new desktops fit their window count; Claude picks layouts
  windowOpacity: number;
  launcherAutoHide: boolean; // the launcher (bottom bar) overlays and hides; windows get its space
  launcherOrder: 'windows' | 'fixed'; // windows: follow tile order, closed apps after; fixed: by app type
  launcherGroup: boolean; // an app's windows share one launcher icon, with a menu to pick one
  dockOpen: 'click' | 'hover'; // a hidden dock slides out when its tab is clicked, or on hover
  waitingGlow: boolean; // faint amber edge glow while Claude waits on the user
  theme: 'dark' | 'light' | 'system'; // the design tokens' theme (system: follow macOS)
  signals: boolean; // the signal layer: the wallpaper light points at windows and reports (done, failed, progress)
  signalStrength: 'subtle' | 'normal' | 'strong'; // how bright signals get
  signalDone: boolean; // automatic: a green bloom after a long turn
  signalFailed: boolean; // automatic: red behind Tests when a run fails
  animateBackground: boolean; // preset wallpapers drift slowly
  wheelDesktops: boolean; // vertical scroll outside any window switches desktops
  disabledApps: string[]; // app types the user turned off: hidden, and their commands refused
  scope: 'session' | 'folder'; // one glass per session, or one per project folder shared by its sessions
  nestedView: boolean; // one screen: newest window big, older ones spiral into smaller panes
  nestedStyle: 'spiral' | 'carousel'; // how the nested view arranges windows around the focused one
  defaultPreset: string; // preset applied to every brand-new glass ('' = none)
  selectToInteract: boolean; // click a window to use it; the wheel over the others walks desktops
  appSettings: Record<string, Record<string, unknown>>; // per app type: values for the settings its manifest declares
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
  // Windows docked at an edge or corner (shown to users as "dock"; stored as "tucked"): out of the
  // tiling flow, on every desktop, shown on hover or kept open.
  tucked?: Partial<Record<Dock, string[]>>;
  // Docks that stay open; the layout makes room for them.
  tuckKeep?: Dock[];
  // Dock sizes the user dragged (px: width for left/right and corners, height for top/bottom).
  tuckSize?: Partial<Record<Dock, number>>;
  // The signal layer: Claude's latest signal (the wallpaper light points at a window, flags one that
  // broke, or shows progress). The renderer plays it once and lets it decay; `seq` replays a repeat.
  signal?: Signal;
  // Corner docks' heights the user dragged (px).
  tuckHeight?: Partial<Record<Corner, number>>;
  // How a dock's windows share its length (fractions summing to 1, in dock order). Ignored once
  // the dock's window count changes (they split evenly again).
  tuckSplit?: Partial<Record<Dock, number[]>>;
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
  | { type: 'window.tuck'; id: string; edge: Dock; index?: number } // dock it; index: position in the dock (default last)
  | { type: 'window.untuck'; id: string; index?: number } // index: slot in the layout (default 0)
  | { type: 'instance.delete'; id: string } // remove a window and its state entirely
  | { type: 'tuck.keep'; edge: Dock; keep: boolean }
  | { type: 'tuck.split'; edge: Dock; shares: number[] } // one share per window in the dock
  | { type: 'tuck.size'; edge: Dock; size?: number; height?: number } // height: corners only
  | { type: 'signal'; kind: Signal['kind'] | 'clear'; target?: string; value?: number; label?: string };

export interface Envelope {
  op: 'ping' | 'hook' | 'dispatch' | 'view' | 'state' | 'catalog' | 'guide' | 'mods' | 'config' | 'preset' | 'quit';
  [k: string]: unknown;
}

export interface Reply {
  ok: boolean;
  result?: unknown;
  error?: string;
}
