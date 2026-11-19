/**
 * Security regression tests: secrets never reach the browser or logs, uploads are bounded,
 * exports are spreadsheet-safe, provider hosts are allow-listed (no SSRF), and credentials can
 * only be stored as server-side references.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, setupWorkspace, signIn, upload, type Client, type Harness } from '../helpers/harness';
import { redact } from '../../server/observability/logger';
import { csvCell } from '../../server/modules/reports/export';
import { isSigninAllowed } from '../../server/config';
import request from 'supertest';

const FAKE_KEY = 'sk-test-should-never-leave-the-server-123456';
let h: Harness;
let c: Client;
let accountId: string;

beforeAll(async () => {
  h = createHarness({ env: { AI_PROVIDER: 'gemini', AI_MODEL: 'test-model', GEMINI_API_KEY: FAKE_KEY, UPLOAD_MAX_BYTES: '2048' } });
  c = await signIn(h.app);
  ({ accountId } = await setupWorkspace(c));
});
afterAll(async () => {
  await h.close();
});

describe('secrets', () => {
  it('the session payload never contains server secrets', async () => {
    const s = await c.get('/api/v1/session');
    expect(s.status).toBe(200);
    const body = JSON.stringify(s.body);
    expect(body).not.toContain(FAKE_KEY);
    expect(body).not.toContain(h.cfg.SESSION_SECRET);
    expect(body).not.toContain(h.cfg.DATABASE_URL);
  });

  it('health endpoints do not leak configuration', async () => {
    const r = await c.get('/api/health/ready');
    const body = JSON.stringify(r.body);
    expect(body).not.toContain(FAKE_KEY);
    expect(body).not.toMatch(/postgres(ql)?:\/\//);
  });

  it('the logger redacts secret-looking keys at any depth', () => {
    const out = redact({ password: 'p', nested: { authToken: 't', apiKey: 'k', headers: { Authorization: 'a', Cookie: 'c' } }, ok: 'visible' });
    expect(JSON.stringify(out)).not.toMatch(/"(p|t|k|a|c)"/);
    expect((out as { ok: string }).ok).toBe('visible');
  });
});

describe('uploads', () => {
  it('rejects files above the configured byte limit', async () => {
    const big = 'Campaign ID,Launch Date,Sent\n' + 'X,2026-10-01,1\n'.repeat(400);
    const r = await upload(c, accountId, big, 'big.csv');
    expect(r.status).toBe(413);
  });

  it('rejects uploads without the CSRF token', async () => {
    const r = await c.agent.post(`/api/v1/accounts/${accountId}/imports`).attach('file', Buffer.from('a,b\n1,2\n'), { filename: 'x.csv', contentType: 'text/csv' });
    expect(r.status).toBe(403);
  });
});

describe('exports', () => {
  it('neutralizes spreadsheet formulas in text but keeps numbers numeric', () => {
    expect(csvCell('=HYPERLINK("http://evil","x")')).toBe(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(csvCell('+cmd')).toBe("'+cmd");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('-12.5')).toBe('-12.5');
    expect(csvCell(42)).toBe('42');
    expect(csvCell(null)).toBe('');
  });
});

describe('Responsys connections', () => {
  const create = (body: Record<string, unknown>) => c.post(`/api/v1/accounts/${accountId}/connections`, { displayName: 'Main', ...body });

  it('refuses hosts outside the Responsys allow-list (SSRF)', async () => {
    for (const url of ['https://evil.example.com', 'https://169.254.169.254', 'http://login2.responsys.net', 'https://responsys.net.evil.com']) {
      const r = await create({ loginBaseUrl: url, credentialRef: 'env:MAIN' });
      expect(r.status, url).toBeGreaterThanOrEqual(400);
      expect(r.status, url).toBeLessThan(500);
    }
  });

  it('accepts only server-side credential references, never raw secrets', async () => {
    const raw = await create({ loginBaseUrl: 'https://login2.responsys.net', credentialRef: 'user:hunter2' });
    expect(raw.status).toBe(400);
    const ok = await create({ loginBaseUrl: 'https://login2.responsys.net', credentialRef: 'env:MAIN' });
    expect(ok.status).toBe(201);
    expect(ok.body.data.status).not.toBe('connected');
  });
});

describe('sign-in allow-list', () => {
  it('matches exact emails and @domain entries, case-insensitively', () => {
    const cfg = { signinAllowList: ['owner@example.com', '@team.example'] };
    expect(isSigninAllowed(cfg, 'Owner@Example.com')).toBe(true);
    expect(isSigninAllowed(cfg, 'a@team.example')).toBe(true);
    expect(isSigninAllowed(cfg, 'a@evilteam.example')).toBe(false);
    expect(isSigninAllowed(cfg, 'someone@example.com')).toBe(false);
    expect(isSigninAllowed({ signinAllowList: [] }, 'anyone@x.test')).toBe(true);
  });

  it('refuses sign-in for accounts outside the list', async () => {
    const h2 = createHarness({ env: { ALLOWED_SIGNIN_EMAILS: '@allowed.test' } });
    try {
      const denied = await request(h2.app).post('/api/v1/auth/dev-login').send({ email: 'x@other.test' });
      expect(denied.status).toBe(403);
      const ok = await request(h2.app).post('/api/v1/auth/dev-login').send({ email: `y-${Date.now()}@allowed.test` });
      expect(ok.status).toBe(201);
    } finally {
      await h2.close();
    }
  });
});
