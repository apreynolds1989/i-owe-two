// Shared Vite config for the Node-side bundles (the app's main and preload, and the preview harness's).
import type { InlineConfig } from 'vite';

/**
 * Bundle one Node-side entry into `outDir` as a single file, with `electron` provided by the runtime.
 * Unminified, so stack traces from the main process stay readable.
 */
export const nodeBuild = (root: string, entry: string, outDir: string, fileName: string, format: 'es' | 'cjs'): InlineConfig => ({
  configFile: false,
  root,
  logLevel: 'warn',
  build: {
    ssr: entry,
    outDir,
    emptyOutDir: false,
    target: 'node22',
    minify: false,
    rollupOptions: { external: ['electron'], output: { format, entryFileNames: fileName } },
  },
});
