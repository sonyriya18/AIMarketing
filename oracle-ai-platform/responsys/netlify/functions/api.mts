/** All /api/* requests: the Express API running inside one Netlify Function. */
import type { Config } from '@netlify/functions';
import { createProxyHandler } from '../../server/platform/netlify-handler';
import { drainJobs, netlifyRuntime } from '../../server/platform/netlify';

export default createProxyHandler(netlifyRuntime, drainJobs, { drainBudgetMs: 40_000 });

export const config: Config = { path: '/api/*' };
