/**
 * Fails (exit 1) if any production entry point — browser app, API, worker, Netlify functions — can reach test
 * fixtures, mock/demo analytics, or development middleware, directly or transitively (T53, T56).
 */
import { build } from 'esbuild';

const FORBIDDEN_INPUT = [/(^|\/)tests\//, /fixtures?\//, /(^|\/)mocks?\//, /(^|\/)demo\//, /src\/data\/campaigns/, /whatIfEngine/, /problemStrategyEngine/, /connectJobMetrics/, /server\/dev\.ts$/];
const FORBIDDEN_TEXT = [/MOCK_CAMPAIGNS/, /PRECOMPUTED_REPORTS/, /TEST-CAMP-/, /System Status: Connected/];
let failed = false;

async function check(name: string, entry: string, platform: 'node' | 'browser', extraForbidden: RegExp[] = []) {
  const res = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    metafile: true,
    platform,
    format: 'esm',
    packages: platform === 'node' ? 'external' : undefined,
    loader: { '.png': 'empty', '.css': 'empty' },
    logLevel: 'silent',
  });
  const inputs = Object.keys(res.metafile!.inputs);
  const bad = inputs.filter((i) => [...FORBIDDEN_INPUT, ...extraForbidden].some((re) => re.test(i)));
  const text = res.outputFiles.map((f) => f.text).join('\n');
  const badText = FORBIDDEN_TEXT.filter((re) => re.test(text));
  const imports = Object.values(res.metafile!.outputs).flatMap((o) => o.imports.map((i) => i.path));
  const badPkgs = platform === 'node' ? imports.filter((p) => /^(vite|vitest|supertest|@playwright\/test)$/.test(p)) : [];
  if (bad.length || badText.length || badPkgs.length) {
    failed = true;
    console.error(`✗ ${name}: forbidden modules ${JSON.stringify(bad)} text ${badText.map(String)} packages ${badPkgs}`);
  } else console.log(`✓ ${name}: ${inputs.length} modules, no fixtures, mock analytics or dev middleware`);
}

await check('browser app (src/main.tsx)', 'src/main.tsx', 'browser');
await check('API (server/index.ts)', 'server/index.ts', 'node');
await check('worker (server/worker.ts)', 'server/worker.ts', 'node');
await check('Netlify API function', 'netlify/functions/api.mts', 'node');
await check('Netlify scheduled jobs function', 'netlify/functions/jobs-cron.mts', 'node');
process.exit(failed ? 1 : 0);
