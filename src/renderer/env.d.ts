import type { SprintBridge } from '../shared/types';

declare global {
  interface Window {
    /** Exposed by src/preload/preload.ts. */
    sprint: SprintBridge;
  }
}
