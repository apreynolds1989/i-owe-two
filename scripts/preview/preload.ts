// Dev-only fake bridge for scripts/preview: same shape as the real one, fixed made-up data, no token,
// no GitHub. Each screenshot asks the preview main process which scenario to show.
import { contextBridge, ipcRenderer } from 'electron';
import type { AppState, RefreshResult, SprintBridge, SprintMetrics } from '../../src/shared/types';

const scenario = ipcRenderer.invoke('preview:scenario') as Promise<{ state: AppState; metrics?: SprintMetrics }>;
const noop = () => undefined;

const bridge: SprintBridge = {
  getState: () => scenario.then((s) => s.state),
  saveToken: async () => ({ ok: true }),
  clearToken: async () => undefined,
  start: async () => ({ ok: true }),
  showView: noop,
  refresh: noop,
  setTheme: noop,
  setPinned: noop,
  setOpenAtLogin: noop,
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
