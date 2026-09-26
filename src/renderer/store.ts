// Renderer-side mirror of core state, fed by patches from main. Tiny external store for React.
import { useSyncExternalStore } from 'react';
import type { Action, GlassState, GlobalConfig } from '../core/types';

declare global {
  interface Window {
    glass: {
      init(): Promise<{ sessionId: string; state: GlassState; config: GlobalConfig }>;
      dispatch(action: Action): Promise<{ ok: boolean; result?: unknown; error?: string }>;
      setConfig(key: string, value: unknown): Promise<{ ok: boolean; error?: string }>;
      onPatch(fn: (p: any) => void): () => void;
      lastFrame(id: string): Promise<Partial<Record<'cdp' | 'web', string>> | null>;
      onFrame(fn: (f: { id: string; source: 'cdp' | 'web'; data: string }) => void): () => void;
    };
  }
}

export interface Snapshot { state: GlassState; config: GlobalConfig }

let snap: Snapshot | null = null;
const subs = new Set<() => void>();

export async function initStore(): Promise<void> {
  const { state, config } = await window.glass.init();
  snap = { state, config };
  window.glass.onPatch((p) => {
    if (!snap) return;
    const { changed, config: cfg, ...rest } = p;
    const appState = { ...snap.state.appState, ...changed };
    for (const id of Object.keys(appState)) if (!rest.instances[id]) delete appState[id];
    snap = { state: { ...rest, appState }, config: cfg ?? snap.config };
    subs.forEach((f) => f());
  });
}

export function useSnapshot(): Snapshot {
  return useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => snap!);
}

export async function dispatch(action: Action): Promise<unknown> {
  const r = await window.glass.dispatch(action);
  if (!r.ok) console.warn('dispatch failed', action, r.error);
  return r.result;
}

export const setConfig = (key: string, value: unknown) => window.glass.setConfig(key, value);
