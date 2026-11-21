// Dev-only fake bridge for scripts/preview: same shape as the real one, fixed made-up data, no token,
// no GitHub. Each screenshot asks the preview main process which scenario to show.
import { contextBridge, ipcRenderer } from 'electron';
import type { AppBridge, AppState, RefreshResult, ReviewMetrics } from '../../src/shared/types';

const scenario = ipcRenderer.invoke('preview:scenario') as Promise<{ state: AppState; metrics?: ReviewMetrics }>;
const noop = () => undefined;

const bridge: AppBridge = {
  getState: () => scenario.then((s) => s.state),
  saveToken: async () => ({ ok: true }),
  clearToken: async () => undefined,
  start: async () => ({ ok: true }),
  setViewing: async () => ({ ok: true }),
  exportHistory: async () => ({ ok: true }),
  clearHistory: async () => undefined,
  showView: noop,
  refresh: noop,
  setTheme: noop,
  setPinned: noop,
  setOpenAtLogin: noop,
  setPrView: noop,
  copyYourPrs: async () => ({ ok: true }),
  setRememberTeammates: async () => undefined,
  setRecapSeen: noop,
  openExternal: noop,
  hide: noop,
  quit: noop,
  onState: () => noop,
  onLoading: () => noop,
  onResult: (cb: (r: RefreshResult) => void) => {
    void scenario.then((s) => {
      if (s.metrics) setTimeout(() => cb({ ok: true, metrics: s.metrics! }), 50);
    });
    return noop;
  },
};

contextBridge.exposeInMainWorld('sprint', bridge);
