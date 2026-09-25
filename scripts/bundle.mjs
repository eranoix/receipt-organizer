// Bundle the worker, migrator, seed and smoke scripts into dist/ so the
// production image runs them with plain `node`, without tsx or dev deps.
import { build } from 'esbuild';

await build({
  entryPoints: { worker: 'scripts/worker.ts', migrate: 'scripts/migrate.ts', seed: 'scripts/seed.ts', smoke: 'scripts/smoke.ts' },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outExtension: { '.js': '.mjs' },
  external: ['pg-native', 'next', 'next/*'],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'info',
});
