import type { CanvasState, GlobalConfig, InstanceMeta } from '../core/types';

export interface ViewProps<S = any> {
  id: string;
  meta: InstanceMeta;
  state: S;
  width: number;
  height: number;
  run: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  canvas: CanvasState;
  config: GlobalConfig;
}

export const fileUrl = (abs: string) => `canvas-file://f${encodeURI(abs)}`;

export function timeAgo(t: number): string {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
