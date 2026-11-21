import type { AppBridge } from '../shared/types';

declare global {
  interface Window {
    /** Exposed by src/preload/preload.ts. */
    sprint: AppBridge;
  }
}
