// `npm start`: build the app, then launch it straight from the repo.
// `npm run build` (and `npm run dist`, which packages afterwards): build only.
// `--clean-release` (used by `npm run dist`) also empties release/ first. electron-builder names each
// installer after the version and never removes old ones, so stale installers would otherwise pile up.
// Three parts are built with Vite:
//   renderer  src/renderer -> dist/renderer/   (the React UI, a plain web bundle)
//   main      src/main     -> dist/main.js     (Electron main process)
//   preload   src/preload  -> dist/preload.cjs (CommonJS, required for sandboxed preloads)
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { build } from 'vite';
import { nodeBuild } from './viteNode';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');
const dist = join(root, 'dist');
const release = join(root, 'release');

console.log('[i-owe-two] Building...');
rmSync(dist, { recursive: true, force: true });
if (process.argv.includes('--clean-release')) rmSync(release, { recursive: true, force: true });
await build({
  configFile: false,
  root: join(src, 'renderer'),
  base: './',
  logLevel: 'warn',
  plugins: [react()],
  build: {
    outDir: join(dist, 'renderer'),
    emptyOutDir: false,
    // Always emit files (no inlined data: URLs for scripts), and no source maps in the shipped app.
    assetsInlineLimit: 0,
    sourcemap: false,
  },
});
await build(nodeBuild(root, join(src, 'main', 'main.ts'), dist, 'main.js', 'es'));
await build(nodeBuild(root, join(src, 'preload', 'preload.ts'), dist, 'preload.cjs', 'cjs'));
console.log('[i-owe-two] Built to dist/.');

if (!process.argv.includes('--build-only')) {
  // In Node, require('electron') returns the path to the Electron binary, downloading it (and
  // verifying its checksum) on first use. Its types describe the in-app API instead, hence the cast.
  const electronBinary = createRequire(import.meta.url)('electron') as unknown as string;
  // Run from the repo there are no fuses, so strip what the installed app's fuses would block:
  // ELECTRON_RUN_AS_NODE (plain-Node mode), NODE_OPTIONS (IDE terminals often add --require or
  // --inspect, which would open an unauthenticated debugger on the process holding the token), the
  // TLS overrides, and SSLKEYLOGFILE (TLS session keys written to disk; main.ts also removes it).
  const env = { ...process.env };
  for (const name of [
    'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS', 'ELECTRON_ENABLE_LOGGING', 'SSLKEYLOGFILE',
  ]) {
    delete env[name];
  }
  console.log('[i-owe-two] Starting. Look for the icon in your system tray (or menu bar). Quit from its menu.');
  const child = spawn(electronBinary, [root], { stdio: 'inherit', env });
  child.on('exit', (code) => process.exit(code ?? 0));
}
