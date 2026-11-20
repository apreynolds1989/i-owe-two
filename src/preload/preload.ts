// Preload: the only bridge between the sandboxed UI and the main process.
// It exposes exactly the named functions in SprintBridge on `window.sprint`; the UI never gets
// ipcRenderer itself, Node, the filesystem or the token. Built as CommonJS (dist/preload.cjs),
// which Electron requires for sandboxed preloads.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC, type AppState, type RefreshResult, type SprintBridge } from '../shared/types';

/** Subscribe to a channel and hand back an unsubscribe function, without leaking the event object. */
function listen<T>(channel: string, cb: (value: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, value: T) => cb(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const bridge: SprintBridge = {
  getState: () => ipcRenderer.invoke(IPC.getState),
  saveToken: (token) => ipcRenderer.invoke(IPC.saveToken, token),
  clearToken: () => ipcRenderer.invoke(IPC.clearToken),
  start: (input) => ipcRenderer.invoke(IPC.start, input),
  setViewing: (view) => ipcRenderer.invoke(IPC.setViewing, view),
  exportHistory: () => ipcRenderer.invoke(IPC.exportHistory),
  clearHistory: () => ipcRenderer.invoke(IPC.clearHistory),
  showView: (view) => ipcRenderer.send(IPC.showView, view),
  refresh: () => ipcRenderer.send(IPC.refresh),
  setTheme: (theme) => ipcRenderer.send(IPC.setTheme, theme),
  setPinned: (pinned) => ipcRenderer.send(IPC.setPinned, pinned),
  setOpenAtLogin: (open) => ipcRenderer.send(IPC.setOpenAtLogin, open),
  setPrView: (view) => ipcRenderer.send(IPC.setPrView, view),
  copyYourPrs: () => ipcRenderer.invoke(IPC.copyYourPrs),
  setRememberTeammates: (on) => ipcRenderer.invoke(IPC.setRememberTeammates, on),
  setRecapSeen: (key) => ipcRenderer.send(IPC.setRecapSeen, key),
  openExternal: (url) => ipcRenderer.send(IPC.openExternal, url),
  hide: () => ipcRenderer.send(IPC.hide),
  quit: () => ipcRenderer.send(IPC.quit),
  onState: (cb) => listen<AppState>(IPC.state, cb),
  onResult: (cb) => listen<RefreshResult>(IPC.result, cb),
  onLoading: (cb) => listen<boolean>(IPC.loading, cb),
};

contextBridge.exposeInMainWorld('sprint', bridge);
