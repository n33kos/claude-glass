// Apps' public state: each core's share() picks what other apps may read; a reader sees an
// instance's only when its manifest lists that app type in permissions.reads.
import type { SharedEntry } from '../apps/types';
import type { GlassState } from './types';

/** The public state of every instance whose type `reads` lists. */
export function readableShared(s: Pick<GlassState, 'shared' | 'instances'>, reads: string[]): SharedEntry[] {
  if (!reads.length || !s.shared) return [];
  const out: SharedEntry[] = [];
  for (const [id, data] of Object.entries(s.shared)) {
    const inst = s.instances[id];
    if (inst && reads.includes(inst.type)) out.push({ id, type: inst.type, title: inst.title, data });
  }
  return out;
}
