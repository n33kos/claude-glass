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
  modMissing?: boolean; // opened from a Claude session the glass mod isn't running in: nothing feeds it
  turn?: { id: string; startedAt: number; steps: number }; // the turn Claude is working on (each model request is a step)
  lastTurn?: { id: string; durationMs: number; reason: string; at: number }; // how the last turn ended (answer, aborted, refusal, error)
  usage?: SessionUsage; // the context window, cost and plan limits, as Claude Code measures them
}

export interface Attachment {
  id: string;
  label: string; // what the chip says ("server.ts, lines 38–45")
  text: string; // what Claude reads
  from: string; // the app it came from
  at: number;
}

export interface SessionUsage {
  context?: { tokens: number; window: number; percent: number };
  cost?: { usd: number };
  rateLimits?: { kind: string; percentUsed: number; resetsAt?: string }[];
  at: number;
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

/**
 * What the glass does on its own when something happens: nothing, light the window (the
 * signal layer: blue, red for a failure), bring it to the front (slot 0), both, or focus (both,
 * and show the first desktop). Only windows already on screen move; a closed one stays closed.
 */
export type FollowMode = 'off' | 'light' | 'front' | 'both' | 'focus';
export const FOLLOW_MODES: readonly FollowMode[] = ['off', 'light', 'front', 'both', 'focus'];

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
  // Attention, automatic (src/core/events.ts): what the glass does when something happens, so Claude
  // doesn't have to remember. Per kind of event; see FollowMode.
  followEdits: FollowMode; // an edit lands: its diff (Changes)
  followPlans: FollowMode; // a plan is written: the Plan
  followTests: FollowMode; // a test run fails: Tests (lit red)
  followWeb: FollowMode; // a search or page: the Browser
  followImages: FollowMode; // Claude reads an image: Images
  followAgents: FollowMode; // a subagent starts: Agents
  turnProgress: boolean; // a thin white bar along the bottom while Claude works on a turn
  contextGauge: boolean; // how full Claude's context window is, in the top bar
  interruptButton: boolean; // two-way: a Stop button in the top bar while Claude works (ends the turn)
  askBox: boolean; // two-way: an "Ask Claude" field in the top bar, sent as the user's prompt
  viewContext: boolean; // each prompt carries what's on the glass now (costs tokens; Claude ranks windows from it)
  animateBackground: boolean; // preset wallpapers drift slowly
  wheelDesktops: boolean; // vertical scroll outside any window switches desktops
  disabledApps: string[]; // app types the user turned off: hidden, and their commands refused
  scope: 'session' | 'folder'; // one glass per session, or one per project folder shared by its sessions
  nestedView: boolean; // one screen: newest window big, older ones spiral into smaller panes
  nestedStyle: 'spiral' | 'carousel'; // how the nested view arranges windows around the focused one
  defaultPreset: string; // preset applied to every brand-new glass ('' = none)
  selectToInteract: boolean; // click a window to use it; the wheel over the others walks desktops
  appSettings: Record<string, Record<string, unknown>>; // per app type: values for the settings its manifest declares
  toolReminders: boolean; // remind Claude to use Read/Edit/Write when a Bash command did file I/O (the glass mod, hooks/glass-mod.ts)
}

export interface GlassState {
  version: 1;
  session: SessionInfo;
  order: string[];
  desktops: LayoutName[];
  instances: Record<string, InstanceMeta>;
  appState: Record<string, unknown>;
  // Apps' persistent values ("stored"), per app type, every scope; the server saves project and
  // global ones to their own files (src/core/stored.ts) and loads changes other glasses make.
  stored?: Record<string, Record<string, unknown>>;
  settings: SessionSettings;
  ui: { viewingDesktop: number };
  // Things the user attached from the glass for their next prompt (point and ask): the mod adds
  // them as context Claude reads with it, then they're gone.
  attachments?: Attachment[];
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
  | { type: 'app.event'; event: unknown } // a session event from the glass mod (src/core/events.ts)
  | { type: 'stored.set'; app: string; values: Record<string, unknown> } // write an app's persistent values (undefined resets one)
  | { type: 'stored.load'; app: string; values: Record<string, unknown> } // values another glass saved (project/global files)
  | { type: 'stored.reset'; app: string; keys?: string[] } // back to the defaults: those keys, or every one
  | { type: 'attach.add'; label: string; text: string; from: string } // the glass's own window only
  | { type: 'attach.remove'; id: string }
  | { type: 'attach.clear' }
  | { type: 'window.tuck'; id: string; edge: Dock; index?: number } // dock it; index: position in the dock (default last)
  | { type: 'window.untuck'; id: string; index?: number } // index: slot in the layout (default 0)
  | { type: 'instance.delete'; id: string } // remove a window and its state entirely
  | { type: 'tuck.keep'; edge: Dock; keep: boolean }
  | { type: 'tuck.split'; edge: Dock; shares: number[] } // one share per window in the dock
  | { type: 'tuck.size'; edge: Dock; size?: number; height?: number } // height: corners only
  | { type: 'signal'; kind: Signal['kind'] | 'clear'; target?: string; value?: number; label?: string };

export interface Envelope {
  op: 'ping' | 'event' | 'dispatch' | 'action.request' | 'action.wait' | 'action.close' | 'watch' | 'hook' | 'ask' | 'view' | 'state' | 'catalog' | 'guide' | 'apps' | 'stored' | 'config' | 'preset' | 'quit';
  [k: string]: unknown;
}

export interface Reply {
  ok: boolean;
  result?: unknown;
  error?: string;
}
