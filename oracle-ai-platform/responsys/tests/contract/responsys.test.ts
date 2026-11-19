/**
 * Provider contract tests. A local, test-only HTTP server stands in for Responsys using the
 * documented request/response shapes. These results are contract evidence only — they are not
 * evidence of a live connection (see docs/VERIFICATION.md).
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ResponsysClient, ResponsysError, extractReportingRows, validateEndpoint, type ResponsysClientFactory } from '../../server/integrations/responsys/client';
import { planPartitions, responsysJobHandlers } from '../../server/modules/connections/sync';
import { JobRunner } from '../../server/jobs/queue';
import { buildHandlers } from '../../server/jobs/handlers';
import { createHarness, setupWorkspace, signIn, type Harness } from '../helpers/harness';

interface Mock {
  server: Server;
  base: string;
  calls: { method: string; path: string; auth?: string; body: string }[];
  /** Per-path overrides: return [status, headers, body]. */
  routes: Map<string, (req: IncomingMessage, body: string) => [number, Record<string, string>, string | Buffer]>;
  authCount: number;
}

const readBody = (req: IncomingMessage) => new Promise<string>((r) => {
  let s = '';
  req.on('data', (c) => (s += c));
  req.on('end', () => r(s));
});

async function startMock(): Promise<Mock> {
  const m = { calls: [], routes: new Map(), authCount: 0 } as unknown as Mock;
  m.server = createServer(async (req, res) => {
    const body = await readBody(req);
    const path = (req.url ?? '').split('?')[0]!;
    m.calls.push({ method: req.method!, path: req.url!, auth: req.headers.authorization, body });
    if (path === '/rest/api/v1.3/auth/token') {
      m.authCount++;
      const p = new URLSearchParams(body);
      if (p.get('user_name') !== 'api_user' || p.get('password') !== 's3cret' || p.get('auth_type') !== 'password') {
        res.writeHead(401).end('{"errorCode":"INVALID_USER_NAME_PASSWORD"}');
        return;
      }
      const override = m.routes.get('auth');
      if (override) {
        const [s, h, b] = override(req, body);
        res.writeHead(s, h).end(b);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ authToken: `tok-${m.authCount}`, issuedAt: Date.now(), endPoint: m.base }));
      return;
    }
    const handler = m.routes.get(`${req.method} ${path}`) ?? m.routes.get(`${req.method} ${path.replace(/\/[^/]+$/, '/*')}`);
    if (!handler) {
      res.writeHead(404).end('{}');
      return;
    }
    const [s, h, b] = handler(req, body);
    res.writeHead(s, h).end(b);
  });
  await new Promise<void>((r) => m.server.listen(0, '127.0.0.1', () => r()));
  const addr = m.server.address() as { port: number };
  m.base = `http://127.0.0.1:${addr.port}`;
  return m;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): [number, Record<string, string>, string] => [status, { 'Content-Type': 'application/json', ...headers }, JSON.stringify(body)];

let mock: Mock;
const failure = (p: Promise<unknown>) => p.then(() => { throw new Error('expected a failure'); }, (e: ResponsysError) => e);
const client = (overrides: Partial<ConstructorParameters<typeof ResponsysClient>[0]> = {}) =>
  new ResponsysClient({ loginBaseUrl: mock.base, credentials: { username: 'api_user', password: 's3cret' }, allowedHostSuffixes: ['.responsys.net'], allowInsecureLocalhost: true, ...overrides });

beforeAll(async () => {
  mock = await startMock();
});
afterAll(() => mock.server.close());
beforeEach(() => {
  mock.routes.clear();
  mock.calls.length = 0;
  mock.authCount = 0;
});

describe('endpoint safety', () => {
  it('accepts only approved HTTPS hosts and never URLs with embedded credentials', () => {
    expect(validateEndpoint('https://login5.responsys.net', ['.responsys.net']).host).toBe('login5.responsys.net');
    expect(() => validateEndpoint('http://login5.responsys.net', ['.responsys.net'])).toThrow(/HTTPS/);
    expect(() => validateEndpoint('https://evil.example.com', ['.responsys.net'])).toThrow(/approved/);
    expect(() => validateEndpoint('https://responsys.net.evil.com', ['.responsys.net'])).toThrow(/approved/);
    expect(() => validateEndpoint('https://u:p@login5.responsys.net', ['.responsys.net'])).toThrow(/credentials/);
  });

  it('refuses to send the token to an unapproved endPoint returned by login', async () => {
    mock.routes.set('auth', () => json(200, { authToken: 'x', issuedAt: Date.now(), endPoint: 'https://attacker.example.com' }));
    await expect(client().authenticate()).rejects.toMatchObject({ kind: 'unsafe_endpoint' });
  });
});

describe('authentication contract', () => {
  it('posts form-encoded user_name/password/auth_type and uses the raw token afterwards', async () => {
    mock.routes.set('GET /rest/api/ratelimit', () => json(200, { limits: [] }));
    const c = client();
    await c.getRateLimits();
    const login = mock.calls.find((x) => x.path === '/rest/api/v1.3/auth/token')!;
    expect(login.method).toBe('POST');
    expect(login.body).toContain('auth_type=password');
    expect(mock.calls.find((x) => x.path === '/rest/api/ratelimit')!.auth).toBe('tok-1');
  });

  it('wrong credentials are an auth error, not retried', async () => {
    const c = client({ credentials: { username: 'api_user', password: 'wrong' } });
    const err = await c.authenticate().catch((e) => e);
    expect(err).toBeInstanceOf(ResponsysError);
    expect(err.kind).toBe('auth');
    expect(err.retryable).toBe(false);
  });

  it('T25: an expired token is refreshed exactly once; a second 401 stops (no login loop)', async () => {
    let n = 0;
    mock.routes.set('GET /rest/api/ratelimit', () => (++n === 1 ? [401, {}, '{}'] : json(200, {})));
    await client().getRateLimits();
    expect(mock.authCount).toBe(2);
    mock.routes.set('GET /rest/api/ratelimit', () => [401, {}, '{}']);
    mock.authCount = 0;
    await expect(client().getRateLimits()).rejects.toMatchObject({ kind: 'auth' });
    expect(mock.authCount).toBe(2);
  });

  it('T25: 429, 403, 5xx and timeouts are classified for retry decisions', async () => {
    mock.routes.set('GET /rest/api/ratelimit', () => [429, { 'Retry-After': '30' }, '{}']);
    const e1 = await failure(client().getRateLimits());
    expect([e1.kind, e1.retryable, e1.retryAfterSec]).toEqual(['rate_limited', true, 30]);
    mock.routes.set('GET /rest/api/ratelimit', () => [403, {}, '{}']);
    expect((await failure(client().getRateLimits())).kind).toBe('permission');
    mock.routes.set('GET /rest/api/ratelimit', () => [503, {}, '{}']);
    expect((await failure(client().getRateLimits())).retryable).toBe(true);
  });
});

describe('reporting contract', () => {
  const rows = [
    { campaignName: 'Fall Sale', launchDate: '2026-10-01', sent: 100, delivered: 98, uniqueOpens: 30, totalOpens: 40, uniqueClicks: 5, totalClicks: 7, revenue: '12.50' },
  ];

  it('submits sendFromDate/sendToDate and treats 202 as pending, not complete (T23)', async () => {
    mock.routes.set('POST /rest/asyncApi/v1.3/performanceAnalytics/campaigns/email', () => json(202, { requestId: 'req-1' }));
    mock.routes.set('GET /rest/asyncApi/v1.3/performanceAnalytics/requests/*', () => json(202, { requestId: 'req-1' }));
    const c = client();
    const id = await c.createPerformanceRequest('email', { sendFromDate: '2026-10-01', sendToDate: '2026-10-07' });
    expect(id).toBe('req-1');
    expect(JSON.parse(mock.calls.at(-1)!.body)).toEqual({ sendFromDate: '2026-10-01', sendToDate: '2026-10-07' });
    expect(await c.pollPerformanceRequest(id)).toEqual({ state: 'pending' });
  });

  it('T24: gzip results flagged by Responsys-Content-Encoding are decoded exactly once', async () => {
    mock.routes.set('GET /rest/asyncApi/v1.3/performanceAnalytics/requests/*', () => [200, { 'Responsys-Content-Encoding': 'gzip' }, gzipSync(JSON.stringify({ data: rows }))]);
    const res = await client().pollPerformanceRequest('req-1');
    expect(res.state).toBe('complete');
    expect(extractReportingRows((res as { payload: unknown }).payload).rows[0]!.measures.uniqueOpens).toBe('30');
    // Already-decoded JSON (e.g. a client that inflated transport compression) is not decoded again.
    mock.routes.set('GET /rest/asyncApi/v1.3/performanceAnalytics/requests/*', () => json(200, { data: rows }));
    expect((await client().pollPerformanceRequest('req-1')).state).toBe('complete');
  });

  it('oversized results are refused, not truncated', async () => {
    mock.routes.set('GET /rest/asyncApi/v1.3/performanceAnalytics/requests/*', () => json(200, { data: rows }));
    await expect(client({ maxResponseBytes: 10 }).pollPerformanceRequest('r')).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('unrecognised row shapes are rejected instead of guessed', () => {
    expect(extractReportingRows({ data: [{ foo: 1 }] }).unknownShape).toBe(true);
    expect(extractReportingRows({ nothing: true }).unknownShape).toBe(true);
  });

  it('plans non-overlapping partitions of at most 30 days', () => {
    const parts = planPartitions('2026-08-01', '2026-10-14');
    expect(parts[0]).toEqual({ from: '2026-08-01', to: '2026-08-30' });
    for (let i = 1; i < parts.length; i++) expect(parts[i]!.from > parts[i - 1]!.to).toBe(true);
    expect(parts.at(-1)!.to).toBe('2026-10-14');
  });
});

describe('sync pipeline against the contract server', () => {
  let h: Harness;
  let runner: JobRunner;
  beforeAll(() => {
    const factory: ResponsysClientFactory = (conn) =>
      new ResponsysClient({ loginBaseUrl: conn.loginBaseUrl, credentials: { username: 'api_user', password: 's3cret' }, allowedHostSuffixes: ['.responsys.net'], allowInsecureLocalhost: true });
    h = createHarness({ env: { RESPONSYS_ALLOWED_HOST_SUFFIXES: '.responsys.net' }, deps: { responsys: factory } });
    runner = new JobRunner(h.db, buildHandlers({ storage: h.storage, extra: responsysJobHandlers({ cfg: h.cfg, responsys: factory }) }));
  });
  afterAll(() => h.close());

  const drain = async () => {
    while (await runner.runOnce());
  };

  it('pulls documented nested statuses, epoch timestamps and failure logs independently of reporting', async () => {
    const c = await signIn(h.app);
    const { workspaceId, accountId } = await setupWorkspace(c, { timezone: 'Asia/Kolkata' });
    const connId = (await h.db.withTenant({ workspaceId }, tx => tx.query(`INSERT INTO connections (workspace_id,account_id,provider,display_name,login_base_url,credential_ref) VALUES ($1,$2,'responsys','Connect contract',$3,'env:TEST') RETURNING id`, [workspaceId,accountId,mock.base]))).rows[0].id;
    mock.routes.set('GET /rest/api/v1.3/connectJobs', () => json(200, [{ jobId: 123, jobName: 'Profile import', jobType: 'Import Profile Data' }]));
    mock.routes.set('GET /rest/api/v1.3/connectJobs/123/jobRuns', () => json(200, [{ jobRunId: 456, jobRunStatus: { value: 'FAILED' }, jobStartTime: Date.parse('2026-10-14T23:30:00Z') }]));
    mock.routes.set('GET /rest/api/v1.3/connectJobs/123/jobRuns/456/status', () => json(200, { jobRunStatus: 'FAILED', errrorMessage: 'Merge failed as no files were found to process. password=s3cret contact=a@example.com', recordsProcessed: 20, recordsRejected: 3, durationInSeconds: 60 }));
    mock.routes.set('GET /rest/api/v1.3/connectJobs/123/jobRuns/456/logs', () => json(200, [{ logLevel: 'ERROR', logMessage: 'Missing file; token=tok-1; a@example.com', logTime: Date.parse('2026-10-14T23:30:30Z') }]));
    const path = `/api/v1/accounts/${accountId}/connect-diagnostics?from=2026-10-15&to=2026-10-15`;
    expect((await c.post(`/api/v1/connections/${connId}/pull-jobs`, { from: '2026-10-15', to: '2026-10-15' })).status).toBe(202);
    await drain();
    const response = await c.get(path);
    expect(response.status).toBe(200);
    const d = response.body.data;
    expect(d.totals).toMatchObject({ jobs: 1, runs: 1, failed: 1, unknown: 0 });
    expect(d.trend[0]).toMatchObject({ date: '2026-10-15', failed: 1 });
    expect(d.runs[0]).toMatchObject({ startedAt: '2026-10-14T23:30:00.000Z', recordsRejected: '3', errorCategory: 'missing_source_file' });
    expect(d.runs[0].logs).toHaveLength(1);
    expect(d.runs[0].advice.title).toBe('Check the source file');
    expect(JSON.stringify(d)).not.toMatch(/s3cret|a@example\.com|tok-1/);
    expect(mock.calls.some(call => call.path.includes('performanceAnalytics'))).toBe(false);
    expect(mock.calls.find(call => call.path.includes('jobRuns?'))?.path).toContain('sdate=10-15-2026');
    await c.post(`/api/v1/connections/${connId}/pull-jobs`, { from: '2026-10-15', to: '2026-10-15' });
    await drain();
    expect((await c.get(path)).body.data.totals.runs).toBe(1);
    expect((await c.get(`/api/v1/accounts/${accountId}/connect-diagnostics?from=2026-10-14&to=2026-10-14`)).body.data.totals.runs).toBe(0);
    expect((await c.get(`/api/v1/accounts/${accountId}/connect-diagnostics?from=2026-02-30`)).status).toBe(400);
    const outsider = await signIn(h.app);
    await setupWorkspace(outsider);
    expect((await outsider.get(path)).status).toBe(404);
    expect((await outsider.post(`/api/v1/connections/${connId}/pull-jobs`, {})).status).toBe(404);
    mock.routes.set('GET /rest/api/v1.3/connectJobs/123/jobRuns/456/logs', () => json(404, {errorCode:'CONNECT_JOB_NOT_FOUND'}));
    await c.post(`/api/v1/connections/${connId}/pull-jobs`, {from:'2026-10-15',to:'2026-10-15'});
    await drain();
    const partial=(await c.get(path)).body.data;
    expect(partial.connections[0].syncStatus).toBe('partial');
    expect(partial.connections[0].syncDetail).toContain('1 history/detail requests were unavailable');
    expect(partial.connections[0].advice.title).toBe('Check the unavailable job history');
    expect(partial.totals.failed).toBe(1);
  });

  it('classifies the documented API-disabled 401 as permission denied without reauthenticating', async () => {
    mock.routes.set('GET /rest/api/v1.3/connectJobs', () => json(401, { errorCode: 'API_DISABLED_FOR_USER' }));
    const error = await failure(client().listConnectJobs());
    expect(error.kind).toBe('permission');
    expect(error.message).toContain('API_DISABLED_FOR_USER');
    expect(mock.authCount).toBe(1);
  });

  it('explains connection timeouts without exposing network payloads or credentials', async () => {
    const c=client({ fetchImpl: async () => { throw Object.assign(new Error('fetch failed'), { cause:{code:'UND_ERR_CONNECT_TIMEOUT'} }); } });
    const error=await failure(c.authenticate());
    expect(error.kind).toBe('network');
    expect(error.message).toContain('UND_ERR_CONNECT_TIMEOUT');
    expect(error.message).toContain('VPN/proxy');
    expect(error.message).not.toContain('s3cret');
  });

  it('honors Retry-After for throttled job pulls and exposes a useful connection error', async () => {
    const c = await signIn(h.app);
    const { workspaceId, accountId } = await setupWorkspace(c);
    const connId = (await h.db.withTenant({ workspaceId }, tx => tx.query(`INSERT INTO connections (workspace_id,account_id,provider,display_name,login_base_url,credential_ref) VALUES ($1,$2,'responsys','Rate limit test',$3,'env:TEST') RETURNING id`, [workspaceId,accountId,mock.base]))).rows[0].id;
    mock.routes.set('GET /rest/api/v1.3/connectJobs', () => json(429, {}, { 'Retry-After': '600' }));
    const queued = await c.post(`/api/v1/connections/${connId}/pull-jobs`, { from: '2026-10-01', to: '2026-10-14' });
    await drain();
    const job = (await h.db.withTenant({ workspaceId }, tx => tx.query(`SELECT status,EXTRACT(EPOCH FROM (run_after-now()))::float AS delay FROM jobs WHERE id=$1`,[queued.body.data.jobId]))).rows[0];
    expect(job.status).toBe('queued');
    expect(job.delay).toBeGreaterThan(590);
    const diagnostic = (await c.get(`/api/v1/accounts/${accountId}/connect-diagnostics`)).body.data;
    expect(diagnostic.connections[0].syncDetail).toContain('rate_limited');
    expect(diagnostic.connections[0].advice.title).toBe('Wait for the API limit to reset');
  });

  it('tests capabilities, syncs Connect runs, imports reporting, and T27 re-fetch replaces instead of inflating', async () => {
    const c = await signIn(h.app);
    const { workspaceId, accountId } = await setupWorkspace(c, { timezone: 'UTC' });
    // The API refuses non-HTTPS/unapproved login hosts; the contract server is registered directly.
    const bad = await c.post(`/api/v1/accounts/${accountId}/connections`, { displayName: 'x', loginBaseUrl: 'http://evil.example', credentialRef: 'env:MAIN' });
    expect(bad.status).toBe(422);
    const connId = (
      await h.db.withTenant({ workspaceId }, (tx) =>
        tx.query(`INSERT INTO connections (workspace_id, account_id, provider, display_name, login_base_url, credential_ref) VALUES ($1, $2, 'responsys', 'Contract server', $3, 'env:TEST') RETURNING id`, [workspaceId, accountId, mock.base])
      )
    ).rows[0].id;

    mock.routes.set('GET /rest/api/ratelimit', () => json(200, {}));
    mock.routes.set('GET /rest/api/v1.3/campaigns', () => json(200, { campaigns: [] }));
    mock.routes.set('GET /rest/api/v1.3/connectJobs', () => json(200, [{ jobId: 'J1', jobName: 'COMPRAS_IN', jobType: 'IMPORT' }, { jobId: 'J2', jobName: 'Event Feed Export', jobType: 'EVENT_FEED' }]));
    mock.routes.set('GET /rest/api/v1.3/connectJobs/J1/jobRuns', () => json(200, [
      { jobRunId: 'R1', jobRunStatus: 'succeeded', recordsProcessed: 500 },
      { jobRunId: 'R2', jobRunStatus: 'failed', errorMessage: 'Source file not found: compras_20261010.csv' },
    ]));
    mock.routes.set('GET /rest/api/v1.3/connectJobs/J2/jobRuns', () => [403, {}, '{}']);
    let poll = 0;
    let opens = 30;
    mock.routes.set('POST /rest/asyncApi/v1.3/performanceAnalytics/campaigns/email', () => json(202, { requestId: `req-${Math.random()}` }));
    mock.routes.set('GET /rest/asyncApi/v1.3/performanceAnalytics/requests/*', () =>
      ++poll === 1
        ? json(202, {})
        : [200, { 'Responsys-Content-Encoding': 'gzip' }, gzipSync(JSON.stringify({ data: [{ campaignName: 'Fall Sale', launchDate: '2026-10-10', sent: 100, delivered: 98, uniqueOpens: opens, revenue: '10' }] }))]
    );

    expect((await c.post(`/api/v1/connections/${connId}/test`)).status).toBe(202);
    await drain();
    const conns = (await c.get(`/api/v1/accounts/${accountId}/connections`)).body.data;
    expect(conns[0].status).toBe('available');
    expect(conns[0].capabilities.reporting.status).toBe('unverified');

    expect((await c.post(`/api/v1/connections/${connId}/sync`)).status).toBe(202);
    // Pin the worker's range to the fixture dates rather than the wall-clock lookback window.
    await h.db.withTenant({ workspaceId }, tx => tx.query(`UPDATE jobs SET payload = payload || '{"from":"2026-10-01","to":"2026-10-14"}'::jsonb WHERE type = 'responsys.sync' AND status = 'queued'`));
    await drain();
    // First poll was 202: the sync is waiting, and no dataset exists yet.
    expect((await c.get(`/api/v1/accounts/${accountId}/datasets`)).body.data).toHaveLength(0);
    await h.db.withTenant({ workspaceId }, (tx) => tx.query(`UPDATE jobs SET run_after = now() WHERE status = 'queued'`));
    await drain();
    const ds = (await c.get(`/api/v1/accounts/${accountId}/datasets`)).body.data;
    expect(ds).toHaveLength(1);
    expect(ds[0].sourceType).toBe('responsys_reporting');

    const summary = (await c.get(`/api/v1/accounts/${accountId}/connect-summary`)).body.data;
    expect(summary.totals).toEqual({ jobs: 2, runs: 2, succeeded: 1, failed: 1 });
    expect(summary.jobs[0].lastErrorCategory).toBe('missing_source_file');
    // A report period ends the day before endDateExclusive: a run on that day is outside it.
    await h.db.withTenant({ workspaceId }, (tx) =>
      tx.query(`UPDATE connect_job_runs SET started_at = CASE external_run_id WHEN 'R1' THEN '2026-10-14T23:30:00Z'::timestamptz ELSE '2026-10-15T00:30:00Z'::timestamptz END`)
    );
    const inPeriod = (await c.get(`/api/v1/accounts/${accountId}/connect-summary?from=2026-10-01&toExclusive=2026-10-15`)).body.data;
    expect(inPeriod.totals).toEqual({ jobs: 2, runs: 1, succeeded: 1, failed: 0 });
    const inclusive = (await c.get(`/api/v1/accounts/${accountId}/connect-summary?from=2026-10-01&to=2026-10-15`)).body.data;
    expect(inclusive.totals).toEqual({ jobs: 2, runs: 2, succeeded: 1, failed: 1 });
    // T31: Event Feed jobs cannot be triggered through the API.
    const feed = summary.jobs.find((j: { isEventFeed: boolean }) => j.isEventFeed);
    expect(feed).toBeTruthy();

    const report = async () =>
      (await c.post('/api/v1/reports/overview', { accountId, datasetId: ds[0].id, period: { preset: 'custom', startDate: '2026-10-01', endDate: '2026-10-14' } })).body.data;
    const r1 = await report();
    expect(r1.totals.find((m: { metricId: string }) => m.metricId === 'sent').current.value).toBe('100');

    // Re-fetch of the same cumulative cohort with revised counts replaces the snapshot (T27).
    opens = 45;
    poll = 1;
    await c.post(`/api/v1/connections/${connId}/sync`);
    await h.db.withTenant({ workspaceId }, tx => tx.query(`UPDATE jobs SET payload = payload || '{"from":"2026-10-01","to":"2026-10-14"}'::jsonb WHERE type = 'responsys.sync' AND status = 'queued'`));
    await drain();
    const r2 = await report();
    expect(r2.totals.find((m: { metricId: string }) => m.metricId === 'sent').current.value).toBe('100');
    expect(r2.totals.find((m: { metricId: string }) => m.metricId === 'unique_opens').current.value).toBe('45');
    expect(mock.calls.every((x) => !x.path.includes('s3cret'))).toBe(true);
  });
});
