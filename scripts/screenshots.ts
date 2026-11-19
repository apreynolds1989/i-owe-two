// `npm run screenshots`: builds the app, builds the dev-only preview harness (scripts/preview) into
// .preview/, then renders every screen in light and dark to screenshots/. Uses made-up data only.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type InlineConfig } from 'vite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.preview');

const run = (cmd: string, args: string[]) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: root, shell: false });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

// The app's own build first (renderer is what gets screenshotted).
run(process.execPath, [join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(root, 'scripts', 'dev.ts'), '--build-only']);

const nodeBuild = (entry: string, fileName: string, format: 'es' | 'cjs'): InlineConfig => ({
  configFile: false,
  root,
  logLevel: 'warn',
  build: {
    ssr: entry,
    outDir,
    emptyOutDir: false,
    target: 'node22',
    rollupOptions: { external: ['electron'], output: { format, entryFileNames: fileName } },
  },
});
await build(nodeBuild(join(root, 'scripts', 'preview', 'main.ts'), 'main.js', 'es'));
await build(nodeBuild(join(root, 'scripts', 'preview', 'preload.ts'), 'preload.cjs', 'cjs'));

const electronBinary = createRequire(import.meta.url)('electron') as unknown as string;
const { ELECTRON_RUN_AS_NODE: _ignored, ...env } = process.env;
const r = spawnSync(electronBinary, [join(outDir, 'main.js')], { stdio: 'inherit', env });
process.exit(r.status ?? 0);
