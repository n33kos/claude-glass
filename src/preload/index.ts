import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('glass', {
  init: () => ipcRenderer.invoke('glass:init'),
  dispatch: (action: unknown) => ipcRenderer.invoke('glass:dispatch', action),
  setConfig: (key: string, value: unknown) => ipcRenderer.invoke('glass:config', key, value),
  onPatch: (fn: (patch: unknown) => void) => {
    const h = (_e: unknown, p: unknown) => fn(p);
    ipcRenderer.on('glass:patch', h);
    return () => ipcRenderer.removeListener('glass:patch', h);
  },
});
