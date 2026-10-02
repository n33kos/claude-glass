import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('glass', {
  init: () => ipcRenderer.invoke('glass:init'),
  dispatch: (action: unknown) => ipcRenderer.invoke('glass:dispatch', action),
  setConfig: (key: string, value: unknown) => ipcRenderer.invoke('glass:config', key, value),
  webAspect: (aspect: number) => ipcRenderer.send('glass:webAspect', aspect),
  webInput: (input: unknown) => ipcRenderer.send('glass:webInput', input),
  resetAppData: (type: string) => ipcRenderer.invoke('glass:resetAppData', type),
  preset: (action: string, name?: string, description?: string) => ipcRenderer.invoke('glass:preset', action, name, description),
  readDoc: (id: string, path: string) => ipcRenderer.invoke('glass:readDoc', id, path),
  projectImages: () => ipcRenderer.invoke('glass:projectImages'),
  getUpdate: () => ipcRenderer.invoke('glass:getUpdate'),
  version: () => ipcRenderer.invoke('glass:version'),
  applyUpdate: () => ipcRenderer.send('glass:applyUpdate'),
  interrupt: () => ipcRenderer.send('glass:interrupt'),
  submitPrompt: (text: string) => ipcRenderer.send('glass:submitPrompt', text),
  onUpdate: (fn: (u: { version: string } | null) => void) => {
    const h = (_e: unknown, u: { version: string } | null) => fn(u);
    ipcRenderer.on('glass:update', h);
    return () => ipcRenderer.removeListener('glass:update', h);
  },
  openLink: (url: string) => ipcRenderer.send('glass:openLink', url),
  revealFile: (paths: string[]) => ipcRenderer.send('glass:revealFile', paths),
  lastFrame: (id: string) => ipcRenderer.invoke('glass:lastFrame', id),
  onFrame: (fn: (f: { id: string; source: 'cdp' | 'web'; data: string }) => void) => {
    const h = (_e: unknown, f: { id: string; source: 'cdp' | 'web'; data: string }) => fn(f);
    ipcRenderer.on('glass:frame', h);
    return () => ipcRenderer.removeListener('glass:frame', h);
  },
  onFullscreen: (fn: (on: boolean) => void) => {
    const h = (_e: unknown, on: boolean) => fn(on);
    ipcRenderer.on('glass:fullscreen', h);
    return () => ipcRenderer.removeListener('glass:fullscreen', h);
  },
  onPatch: (fn: (patch: unknown) => void) => {
    const h = (_e: unknown, p: unknown) => fn(p);
    ipcRenderer.on('glass:patch', h);
    return () => ipcRenderer.removeListener('glass:patch', h);
  },
});
