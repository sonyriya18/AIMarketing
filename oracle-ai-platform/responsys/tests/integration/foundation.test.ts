/**
 * M1 foundation: auth, CSRF, RBAC, tenant isolation (service and database level), health,
 * configuration refusal, and append-only audit. Runs against real PostgreSQL as rci_app.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { loadConfig } from '../../server/config';
import { createHarness, setupWorkspace, signIn, testEnv, upload, type Harness } from '../helpers/harness';

let h: Harness;
beforeAll(() => {
  h = createHarness();
});
afterAll(async () => {
  await h.close();
});

describe('health', () => {
  it('liveness and readiness reflect real dependencies without leaking config', async () => {
    const { default: request } = await import('supertest');
    const live = await request(h.app).get('/api/health/live');
    expect(live.status).toBe(200);
    const ready = await request(h.app).get('/api/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.checks).toEqual({ database: true, objectStorage: true });
    expect(JSON.stringify(ready.body)).not.toMatch(/postgres|password|rci_/i);
  });
});

describe('authentication and CSRF', () => {
  it('rejects unauthenticated API access and uploads', async () => {
    const { default: request } = await import('supertest');
    expect((await request(h.app).get('/api/v1/session')).status).toBe(401);
    const up = await request(h.app).post('/api/v1/accounts/00000000-0000-0000-0000-000000000000/imports').attach('file', Buffer.from('a,b\n1,2'), 'x.csv');
    expect([401, 403]).toContain(up.status);
  });

  it('requires the CSRF token on state-changing requests', async () => {
    const c = await signIn(h.app);
    const res = await c.agent.post('/api/v1/workspaces').send({ name: 'No CSRF' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('forbidden');
  });

  it('logout revokes the session server-side', async () => {
    const c = await signIn(h.app);
    expect((await c.get('/api/v1/session')).status).toBe(200);
    await c.post('/api/v1/auth/logout');
    expect((await c.get('/api/v1/session')).status).toBe(401);
  });

  it('refuses the development identity harness in production configuration', () => {
    expect(() => loadConfig(testEnv({ NODE_ENV: 'production', APP_DATA_MODE: 'production', AUTH_MODE: 'dev', APP_BASE_URL: 'https://x.example' }))).toThrow(/not allowed in production/);
    expect(() => loadConfig(testEnv({ NODE_ENV: 'production', APP_DATA_MODE: 'demo', AUTH_MODE: 'oidc', OIDC_ISSUER_URL: 'https://id.example', OIDC_CLIENT_ID: 'x', APP_BASE_URL: 'https://x.example' }))).toThrow(/APP_DATA_MODE=demo/);
    expect(() => loadConfig(testEnv({ AI_PROVIDER: 'gemini' }))).toThrow(/AI_MODEL/);
  });
});

describe('workspaces and empty state (T01)', () => {
  it('a new workspace has no business data and no fabricated history', async () => {
    const c = await signIn(h.app);
    const { accountId } = await setupWorkspace(c);
    const ds = await c.get(`/api/v1/accounts/${accountId}/datasets`);
    expect(ds.status).toBe(200);
    expect(ds.body.data).toEqual([]);
    const imports = await c.get(`/api/v1/accounts/${accountId}/imports`);
    expect(imports.body.data).toEqual([]);
  });

  it('validates account timezone and currency', async () => {
    const c = await signIn(h.app);
    await setupWorkspace(c);
    expect((await c.post('/api/v1/accounts', { name: 'Bad tz', timezone: 'Mars/Olympus', currency: 'USD' })).status).toBe(400);
    expect((await c.post('/api/v1/accounts', { name: 'Bad cur', timezone: 'UTC', currency: 'XXQ' })).status).toBe(400);
  });
});

describe('tenant isolation (T44, T45, T46) and RBAC', () => {
  it('user B cannot see or guess user A resources', async () => {
    const a = await signIn(h.app);
    const { accountId } = await setupWorkspace(a);
    const up = await upload(a, accountId, 'Campaign ID,Channel,Launch Date,Sent\nX1,Email,2026-10-01,10\n');
    expect(up.status).toBe(201);
    const importId = up.body.data.id;

    const b = await signIn(h.app);
    await setupWorkspace(b);
    expect((await b.get(`/api/v1/accounts/${accountId}/datasets`)).status).toBe(404);
    expect((await b.get(`/api/v1/imports/${importId}`)).status).toBe(404);
    expect((await b.get(`/api/v1/accounts/${accountId}/imports`)).status).toBe(404);
    expect((await b.post(`/api/v1/imports/${importId}/commit`)).status).toBe(404);
    // Switching to A's workspace without membership is refused without revealing it exists.
    const me = await a.get('/api/v1/session');
    const res = await b.post('/api/v1/session/workspace', { workspaceId: me.body.data.workspace.id });
    expect(res.status).toBe(404);
  });

  it('viewers can read but cannot import; removing a membership stops access immediately (T54)', async () => {
    const owner = await signIn(h.app);
    const { accountId } = await setupWorkspace(owner);
    const viewer = await signIn(h.app);
    expect((await owner.post('/api/v1/workspace/members', { email: viewer.email, role: 'viewer' })).status).toBe(201);
    const s = await viewer.get('/api/v1/session');
    const wsId = s.body.data.memberships[0].workspaceId;
    expect((await viewer.post('/api/v1/session/workspace', { workspaceId: wsId })).status).toBe(200);
    await viewer.refresh();
    expect((await viewer.get(`/api/v1/accounts/${accountId}/datasets`)).status).toBe(200);
    const up = await upload(viewer, accountId, 'a,b\n1,2\n');
    expect(up.status).toBe(403);
    const me = await viewer.get('/api/v1/session');
    expect((await owner.del(`/api/v1/workspace/members/${me.body.data.user.id}`)).status).toBe(200);
    expect((await viewer.get(`/api/v1/accounts/${accountId}/datasets`)).status).toBe(403);
  });

  it('rejects grants that a role may not receive and keeps the last owner', async () => {
    const owner = await signIn(h.app);
    await setupWorkspace(owner);
    const bad = await owner.post('/api/v1/workspace/members', { email: 'v@example.test', role: 'viewer', grants: ['action.execute'] });
    expect(bad.status).toBe(422);
    const me = await owner.get('/api/v1/session');
    expect((await owner.del(`/api/v1/workspace/members/${me.body.data.user.id}`)).status).toBe(409);
  });

  it('the runtime role is not a superuser/owner and sees nothing without tenant context', async () => {
    await expect(h.db.assertRuntimeRoleIsSafe()).resolves.toBeUndefined();
    const c = await signIn(h.app);
    await setupWorkspace(c);
    const { rows } = await h.db.query<{ n: number }>('SELECT count(*)::int AS n FROM accounts');
    expect(rows[0]?.n).toBe(0);
    await expect(
      h.db.query(`INSERT INTO accounts (workspace_id, name, timezone, currency) VALUES (gen_random_uuid(), 'x', 'UTC', 'USD')`)
    ).rejects.toThrow(/row-level security|foreign key/);
  });

  it('a tenant cannot reference another tenant\'s rows even inside its own context', async () => {
    const a = await signIn(h.app);
    const wa = await setupWorkspace(a);
    const b = await signIn(h.app);
    const wb = await setupWorkspace(b);
    await expect(
      h.db.withTenant({ workspaceId: wb.workspaceId }, (tx) =>
        tx.query(`INSERT INTO datasets (workspace_id, account_id, name, source_type, grain, time_basis) VALUES ($1, $2, 'x', 'upload_campaign_metrics', 'campaign_launch', 'send_cohort')`, [wb.workspaceId, wa.accountId])
      )
    ).rejects.toThrow(/foreign key/);
    await expect(
      h.db.withTenant({ workspaceId: wb.workspaceId }, (tx) =>
        tx.query(`INSERT INTO datasets (workspace_id, account_id, name, source_type, grain, time_basis) VALUES ($1, $2, 'x', 'upload_campaign_metrics', 'campaign_launch', 'send_cohort')`, [wa.workspaceId, wa.accountId])
      )
    ).rejects.toThrow(/row-level security/);
  });

  it('audit history is append-only for the application role', async () => {
    const c = await signIn(h.app);
    const { workspaceId } = await setupWorkspace(c);
    const { rows } = await h.db.withTenant({ workspaceId }, (tx) => tx.query('SELECT count(*)::int AS n FROM audit_events'));
    expect(rows[0].n).toBeGreaterThan(0);
    await expect(h.db.withTenant({ workspaceId }, (tx) => tx.query(`UPDATE audit_events SET action = 'x'`))).rejects.toThrow(/permission denied/);
    await expect(h.db.withTenant({ workspaceId }, (tx) => tx.query('DELETE FROM audit_events'))).rejects.toThrow(/permission denied/);
  });

  it('unknown API routes and malformed IDs return 404 JSON', async () => {
    const c = await signIn(h.app);
    await setupWorkspace(c);
    expect((await c.get('/api/v1/imports/not-a-uuid')).status).toBe(404);
    expect((await c.get('/api/summary')).status).toBe(404);
  });
});

describe('runtime role check', () => {
  it('refuses to run as a role that bypasses RLS', async () => {
    const owner = process.env.TEST_DATABASE_MIGRATION_URL;
    if (!owner) return;
    const { Db } = await import('../../server/db/pool');
    const db = new Db(owner, 1);
    await expect(db.assertRuntimeRoleIsSafe()).rejects.toThrow(/bypasses row-level security/);
    await db.close();
    void pg;
  });
});
