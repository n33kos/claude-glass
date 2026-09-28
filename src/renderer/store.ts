// Renderer-side mirror of core state, fed by patches from main. Tiny external store for React.
import { useSyncExternalStore } from 'react';
import type { AppInfo } from '../apps/types';
import type { ModReport } from '../core/mods';
import type { Action, GlassState, GlobalConfig } from '../core/types';

declare global {
  interface Window {
    glass: {
      init(): Promise<{ sessionId: string; state: GlassState; config: GlobalConfig; apps: AppInfo[]; mods: ModReport[] }>;
      dispatch(action: Action): Promise<{ ok: boolean; result?: unknown; error?: string }>;
      setConfig(key: string, value: unknown): Promise<{ ok: boolean; error?: string }>;
      onPatch(fn: (p: any) => void): () => void;
      onFullscreen(fn: (on: boolean) => void): () => void;
      readDoc(id: string, path: string): Promise<{ ok: boolean; result?: { path: string; text: string }; error?: string }>;
      openLink(url: string): void;
      webAspect(aspect: number): void;
      webInput(input: unknown): void;
      resetAppData(type: string): Promise<boolean>;
      preset(action: string, name?: string, description?: string): Promise<{ ok: boolean; result?: any; error?: string }>;
      lastFrame(id: string): Promise<Partial<Record<'cdp' | 'web', string>> | null>;
      onFrame(fn: (f: { id: string; source: 'cdp' | 'web'; data: string }) => void): () => void;
    };
  }
}

export interface Snapshot { state: GlassState; config: GlobalConfig }

let snap: Snapshot | null = null;
/** Registered apps (built-in and mods), from main. Fixed for the life of the glass. */
export const apps: Record<string, AppInfo> = {};
export let mods: ModReport[] = [];
const subs = new Set<() => void>();

export async function initStore(): Promise<void> {
  const { state, config, apps: list, mods: reports } = await window.glass.init();
  snap = { state, config };
  for (const a of list) apps[a.type] = a;
  mods = reports;
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
