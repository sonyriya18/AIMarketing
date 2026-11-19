/**
 * Compiles the API, worker, and migration runner into dist-server/ (Node ESM). Dependencies stay
 * external (installed with npm ci --omit=dev). The development entry (server/dev.ts, which loads
 * Vite) is deliberately not built.
 */
import { build } from 'esbuild';
import { cp, rm } from 'node:fs/promises';

await rm('dist-server', { recursive: true, force: true });
await build({
  entryPoints: { index: 'server/index.ts', worker: 'server/worker.ts', migrate: 'server/db/migrate.ts' },
  outdir: 'dist-server',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
});
await cp('server/db/migrations', 'dist-server/migrations', { recursive: true });
console.log('server build complete');
