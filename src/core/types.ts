// Core data model. Pure types, shared by core, main, renderer, and CLI.

export type LayoutName = 'full' | 'split' | 'main-left' | 'columns' | 'grid';

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
  autoOpen: { changes: boolean; plan: boolean; images: boolean };
  windowOpacity?: number;
}

export interface GlobalConfig {
  autoStart: boolean;
  background: string; // preset name or absolute image path
  defaultLayout: LayoutName;
  windowOpacity: number;
  dockAutoHide: boolean; // dock overlays and hides; windows get its space
  dockOrder: 'windows' | 'fixed'; // windows: follow tile order, closed apps after; fixed: by app type
  waitingGlow: boolean; // faint amber edge glow while Claude waits on the user
}

export interface CanvasState {
  version: 1;
  session: SessionInfo;
  order: string[];
  // Pinned windows: id → slot index in `order`. The reducer keeps them there; others flow around.
  pinned?: Record<string, number>;
  desktops: LayoutName[];
  instances: Record<string, InstanceMeta>;
  appState: Record<string, unknown>;
  settings: SessionSettings;
  ui: { viewingDesktop: number };
  // Instances the hooks auto-opened once; never auto-reopened after the user closes them.
  autoOpened: string[];
}

export type Action =
  | { type: 'window.open'; id: string }
  | { type: 'window.close'; id: string }
  | { type: 'window.move'; id: string; index: number }
  | { type: 'window.pin'; id: string; index?: number }
  | { type: 'window.unpin'; id: string }
  | { type: 'window.opacity'; id: string; value: number | null }
  | { type: 'desktop.layout'; desktop: number; layout: LayoutName }
  | { type: 'instance.create'; appType: string; id?: string; title?: string; open?: boolean }
  | { type: 'instance.rename'; id: string; title: string }
  | { type: 'app.command'; id: string; command: string; args?: Record<string, unknown> }
  | { type: 'settings.set'; key: string; value: unknown }
  | { type: 'session.update'; patch: Partial<SessionInfo> }
  | { type: 'ui.viewDesktop'; index: number };

export interface Envelope {
  op: 'ping' | 'hook' | 'dispatch' | 'view' | 'state' | 'catalog' | 'config' | 'quit';
  [k: string]: unknown;
}

export interface Reply {
  ok: boolean;
  result?: unknown;
  error?: string;
}
