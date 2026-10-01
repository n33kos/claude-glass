// React adapter for app views (used by the built-in apps; any custom app may use it too).
//   mount(MyView)  →  <MyView state meta size session run host width height id />
import { useEffect, useState, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import glass, { type GlassProps } from './glass-app';

export interface AppViewProps<S = any> extends Omit<GlassProps<S>, 'size'> {
  width: number;
  height: number;
  run: (command: string, args?: Record<string, unknown>) => void;
  host: (service: string, args?: Record<string, unknown>) => void;
  ask: <T = any>(service: string, args?: Record<string, unknown>) => Promise<T>;
}

export function mount<S>(View: ComponentType<AppViewProps<S>>): void {
  const el = document.createElement('div');
  el.id = 'root';
  document.body.appendChild(el);
  createRoot(el).render(<Root View={View} />);
}

function Root<S>({ View }: { View: ComponentType<AppViewProps<S>> }) {
  const [p, setP] = useState<GlassProps<S> | null>(glass.props);
  useEffect(() => glass.onState((next) => setP(next as GlassProps<S>)), []);
  if (!p) return null;
  return <View {...p} width={p.size.width} height={p.size.height} run={glass.run} host={glass.host} ask={glass.ask} />;
}
