import { BUILTIN_ICONS } from './icons';
import { apps } from './store';

/** An app's image icon: its own (custom apps), else the built-in artwork for its type. */
export const iconSrc = (type?: string): string | undefined => (type ? apps[type]?.iconUrl ?? BUILTIN_ICONS[type] : undefined);

/** An app's icon: its image if it has one, else its glyph. */
export function AppIcon({ type }: { type?: string }) {
  const src = iconSrc(type);
  if (src) return <img className="app-icon" src={src} alt="" draggable={false} />;
  return <>{(type ? apps[type]?.icon : undefined) ?? '▢'}</>;
}
