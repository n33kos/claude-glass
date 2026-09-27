import { apps } from './store';

/** An app's icon: its image if it ships one (custom apps), else its glyph. */
export function AppIcon({ type }: { type?: string }) {
  const app = type ? apps[type] : undefined;
  if (app?.iconUrl) return <img className="app-icon" src={app.iconUrl} alt="" draggable={false} />;
  return <>{app?.icon ?? '▢'}</>;
}
