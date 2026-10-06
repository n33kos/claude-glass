// Which apps are on in a glass. The user turns apps off for every glass (`disabledApps`), and each
// glass can override that (`settings.apps`: true = on here, false = off here), which presets save.
// An off app is hidden, its
// commands are refused, its hooks don't run and its guide stays out of Claude's context.
// Pure: the renderer uses it too.
import type { GlobalConfig, SessionSettings } from './types';

type Config = Pick<GlobalConfig, 'disabledApps'> | Partial<GlobalConfig>;
type Settings = Pick<SessionSettings, 'apps'> | undefined;

export function isAppOff(type: string, config: Config, settings: Settings): boolean {
  if (type === 'settings') return false;
  const here = settings?.apps?.[type];
  if (here !== undefined) return !here;
  return !!config.disabledApps?.includes(type);
}

/** Every off app among `types`. */
export function offApps(types: Iterable<string>, config: Config, settings: Settings): Set<string> {
  const off = new Set<string>();
  for (const t of types) if (isAppOff(t, config, settings)) off.add(t);
  return off;
}
