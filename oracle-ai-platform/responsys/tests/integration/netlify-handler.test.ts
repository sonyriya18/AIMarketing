/**
 * The Netlify Function adapter in front of the real app and database: cookies, CSRF,
 * multipart uploads, client IP handling, job draining after writes, and startup failure.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { createProxyHandler, type PlatformContext } from '../../server/platform/netlify-handler';
import { drainJobs } from '../../server/platform/netlify';
import type { Runtime } from '../../server/runtime';
import { JobRunner } from '../../server/jobs/queue';
import { buildHandlers } from '../../server/jobs/handlers';

const read = async (r: Response): Promise<any> => r.json();
let h: Harness;
let rt: Runtime;
const pending: Promise<unknown>[] = [];
const ctx = (ip = '203.0.113.7'): PlatformContext => ({ ip, site: { url: 'https://example.netlify.app' }, waitUntil: (p) => void pending.push(p) });

beforeAll(() => {
  h = createHarness();
  rt = { cfg: h.cfg, db: h.db, storage: h.storage, ai: undefined as never, responsys: undefined as never, runner: () => new JobRunner(h.db, buildHandlers({ storage: h.storage })) };
});
afterAll(async () => {
  await Promise.allSettled(pending);
  await h.close();
});

describe('Netlify function adapter', () => {
  const handler = () => createProxyHandler(async () => rt, drainJobs, { drainBudgetMs: 10_000 });

  it('serves the API, keeps sessions and CSRF working, accepts uploads and drains jobs after writes', async () => {
    const call = handler();
    const base = 'https://example.netlify.app';
    expect((await call(new Request(`${base}/api/v1/auth/config`), ctx())).status).toBe(200);

    const login = await call(new Request(`${base}/api/v1/auth/dev-login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `nf-${Date.now()}@example.test` }) }), ctx());
    expect(login.status).toBe(201);
    const cookies = login.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith('rci_session=') && /HttpOnly/i.test(c))).toBe(true);
    const cookie = cookies.map((c) => c.split(';')[0]).join('; ');

    const session = await read(await call(new Request(`${base}/api/v1/session`, { headers: { cookie } }), ctx()));
    const csrf = session.data.csrfToken as string;
    const send = (path: string, init: RequestInit = {}) => call(new Request(`${base}${path}`, { ...init, headers: { cookie, 'x-csrf-token': csrf, ...(init.headers as Record<string, string>) } }), ctx());

    expect((await send('/api/v1/workspaces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'NF' }) })).status).toBe(201);
    const noCsrf = await call(new Request(`${base}/api/v1/accounts`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' }), ctx());
    expect(noCsrf.status).toBe(403);
    const acct = await read(await send('/api/v1/accounts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Main', timezone: 'UTC', currency: 'USD' }) }));

    const form = new FormData();
    form.append('file', new Blob([readFileSync('tests/fixtures/golden-campaigns.csv')], { type: 'text/csv' }), 'golden.csv');
    const up = await send(`/api/v1/accounts/${acct.data.id}/imports`, { method: 'POST', body: form });
    expect(up.status).toBe(201);
    const imp = (await read(up)).data;
    expect(imp.format).toBe('campaign_metrics');

    const val = await send(`/api/v1/imports/${imp.id}/validate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mapping: { ...imp.detection.proposal, timezoneConfirmed: true } }) });
    expect(val.status).toBe(200);
    pending.length = 0;
    expect((await send(`/api/v1/imports/${imp.id}/commit`, { method: 'POST' })).status).toBe(202);
    expect(pending.length).toBe(1);
    await Promise.all(pending);
    const done = await read(await send(`/api/v1/imports/${imp.id}`));
    expect(done.data.status).toBe('completed');
  });

  it('answers 503 with a safe message when the runtime cannot start, and recovers later', async () => {
    let fail = true;
    const call = createProxyHandler(async () => {
      if (fail) throw new Error('OIDC_CLIENT_ID missing; postgres://secret@host');
      return rt;
    }, drainJobs, { drainBudgetMs: 1000 });
    const r = await call(new Request('https://example.netlify.app/api/v1/auth/config'), ctx());
    expect(r.status).toBe(503);
    const text = await r.text();
    expect(text).toContain('not_configured');
    expect(text).not.toMatch(/postgres:|OIDC_CLIENT_ID/);
    fail = false;
    expect((await call(new Request('https://example.netlify.app/api/v1/auth/config'), ctx())).status).toBe(200);
  });

  it('forwards the platform client IP and strips caller-supplied forwarding headers', async () => {
    const call = handler();
    await call(new Request('https://example.netlify.app/api/health/live'), ctx()); // start the app
    const realFetch = globalThis.fetch;
    let seen: Headers | null = null;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seen = new Headers(init?.headers);
      return realFetch(input, init);
    }) as typeof fetch;
    try {
      const r = await call(
        new Request('https://example.netlify.app/api/health/live', { headers: { 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '1.2.3.4', 'x-forwarded-host': 'evil.example' } }),
        ctx('198.51.100.9')
      );
      expect(r.status).toBe(200);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(seen!.get('x-forwarded-for')).toBe('198.51.100.9');
    expect(seen!.get('x-real-ip')).toBeNull();
    expect(seen!.get('x-forwarded-host')).toBeNull();
  });
});
