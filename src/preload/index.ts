import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('canvas', {
  init: () => ipcRenderer.invoke('canvas:init'),
  dispatch: (action: unknown) => ipcRenderer.invoke('canvas:dispatch', action),
  setConfig: (key: string, value: unknown) => ipcRenderer.invoke('canvas:config', key, value),
  onPatch: (fn: (patch: unknown) => void) => {
    const h = (_e: unknown, p: unknown) => fn(p);
    ipcRenderer.on('canvas:patch', h);
    return () => ipcRenderer.removeListener('canvas:patch', h);
  },
});
