// The theme in effect (dark or light), from the `theme` setting or macOS's appearance ("system").
// The shell sets it on the page (the tokens switch on [data-theme]); app frames get it in props.
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useState } from 'react';

export type Theme = 'dark' | 'light';
export const ThemeContext = createContext<Theme>('dark');
export const useThemeValue = () => useContext(ThemeContext);

export function useTheme(setting: 'dark' | 'light' | 'system' | undefined): Theme {
  const media = useMemo(() => matchMedia('(prefers-color-scheme: light)'), []);
  const [systemLight, setSystemLight] = useState(media.matches);
  useEffect(() => { const on = () => setSystemLight(media.matches); media.addEventListener('change', on); return () => media.removeEventListener('change', on); }, [media]);
  const theme: Theme = setting === 'light' || (setting === 'system' && systemLight) ? 'light' : 'dark';
  useLayoutEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  return theme;
}
