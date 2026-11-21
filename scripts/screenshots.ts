// `npm run screenshots`: builds the app, builds the dev-only preview harness (scripts/preview) into
// .preview/, then renders every screen in light and dark to screenshots/. Uses made-up data only.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { nodeBuild } from './viteNode';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.preview');

/** Runs a command in the repo and stops this script if it fails. */
const run = (command: string, args: string[]) => {
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: root, shell: false });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

// The app's own build first (renderer is what gets screenshotted).
run(process.execPath, [join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(root, 'scripts', 'dev.ts'), '--build-only']);

await build(nodeBuild(root, join(root, 'scripts', 'preview', 'main.ts'), outDir, 'main.js', 'es'));
await build(nodeBuild(root, join(root, 'scripts', 'preview', 'preload.ts'), outDir, 'preload.cjs', 'cjs'));

const electronBinary = createRequire(import.meta.url)('electron') as unknown as string;
const { ELECTRON_RUN_AS_NODE: _ignored, ...env } = process.env;
const preview = spawnSync(electronBinary, [join(outDir, 'main.js')], { stdio: 'inherit', env });
process.exit(preview.status ?? 0);
