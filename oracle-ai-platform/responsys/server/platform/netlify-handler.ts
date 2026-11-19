/**
 * Serves the unchanged Express application from a Netlify Function. The app listens on a
 * loopback port inside the function instance; each platform Request is forwarded to it with
 * the client IP set by the platform (never trusted from the caller). After a successful
 * state-changing request the instance drains queued jobs in the background (`waitUntil`),
 * and the scheduled function covers anything left over.
 */
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createApp } from '../app';
import type { Runtime } from '../runtime';
import { logger } from '../observability/logger';

export interface PlatformContext {
  ip: string;
  site: { url?: string };
  waitUntil(promise: Promise<unknown>): void;
}

type DrainFn = (rt: Runtime, budgetMs: number) => Promise<number>;

const DROP_REQUEST = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'host', 'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-real-ip', 'accept-encoding']);
const DROP_RESPONSE = new Set(['connection', 'keep-alive', 'transfer-encoding']);

export function createProxyHandler(getRuntime: (siteUrl?: string) => Promise<Runtime>, drain: DrainFn, opts: { drainBudgetMs: number }) {
  let origin: Promise<string> | null = null;
  const start = (siteUrl?: string) => {
    origin ??= (async () => {
      const rt = await getRuntime(siteUrl);
      const app = createApp({ cfg: rt.cfg, db: rt.db, storage: rt.storage, ai: rt.ai, responsys: rt.responsys });
      const server = app.listen(0, '127.0.0.1');
      await once(server, 'listening');
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    })().catch((err) => {
      origin = null;
      throw err;
    });
    return origin;
  };

  return async (req: Request, context: PlatformContext): Promise<Response> => {
    let base: string;
    try {
      base = await start(context.site.url);
    } catch (err) {
      logger.error('startup failed', { error: (err as Error).message });
      return Response.json(
        { error: { code: 'not_configured', message: 'The app is not fully configured yet. The site owner needs to finish setup (sign-in and database).' } },
        { status: 503, headers: { 'Cache-Control': 'no-store' } }
      );
    }
    const url = new URL(req.url);
    const headers = new Headers();
    req.headers.forEach((v, k) => {
      if (!DROP_REQUEST.has(k)) headers.set(k, v);
    });
    headers.set('x-forwarded-for', context.ip);
    headers.set('x-forwarded-proto', url.protocol.replace(':', ''));
    headers.set('accept-encoding', 'identity');
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const res = await fetch(base + url.pathname + url.search, {
      method: req.method,
      headers,
      body: hasBody ? req.body : undefined,
      redirect: 'manual',
      duplex: 'half',
    } as RequestInit);
    if (hasBody && res.status < 400) {
      context.waitUntil(
        getRuntime()
          .then((rt) => drain(rt, opts.drainBudgetMs))
          .catch((err) => logger.warn('job drain failed', { error: (err as Error).message }))
      );
    }
    const out = new Headers();
    res.headers.forEach((v, k) => {
      if (!DROP_RESPONSE.has(k) && k !== 'set-cookie') out.set(k, v);
    });
    for (const c of res.headers.getSetCookie()) out.append('set-cookie', c);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
  };
}
