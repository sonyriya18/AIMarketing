/**
 * Oracle Responsys REST adapter (server-only).
 *
 * Implemented against Oracle's documented operations (blueprint 8.2):
 *   POST {login}/rest/api/v1.3/auth/token          form: user_name, password, auth_type=password
 *        → { authToken, issuedAt, endPoint }        token valid ~2 hours
 *   GET  /rest/api/ratelimit
 *   GET  /rest/api/v1.3/campaigns                    (limit/offset)
 *   GET  /rest/api/v1.3/connectJobs
 *   GET  /rest/api/v1.3/connectJobs/{id}/jobRuns?sdate=MM-DD-YYYY&edate=MM-DD-YYYY
 *   GET  /rest/api/v1.3/connectJobs/{id}/jobRuns/{runId}/status   → jobRunStatus, errorMessage, recordsProcessed
 *   GET  /rest/api/v1.3/connectJobs/{id}/jobRuns/{runId}/logs
 *   POST /rest/asyncApi/v1.3/performanceAnalytics/campaigns/{email|sms|mobileapps}
 *        body { sendFromDate, sendToDate, campaignName?, programName?, folderName? } → 202 { requestId }
 *   GET  /rest/asyncApi/v1.3/performanceAnalytics/requests/{requestId}
 *        gzip payload flagged by "Responsys-Content-Encoding: gzip"
 *
 * Everything not listed above is deliberately absent. Live behaviour has not been verified in
 * this repository (no authorized account); see docs/RESPONSYS_SETUP.md.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import type { AppConfig } from '../../config';

export type ResponsysErrorKind =
  | 'auth'
  | 'permission'
  | 'rate_limited'
  | 'not_found'
  | 'server'
  | 'timeout'
  | 'network'
  | 'invalid_response'
  | 'unsafe_endpoint'
  | 'credentials_missing'
  | 'unsupported';

export class ResponsysError extends Error {
  constructor(
    message: string,
    readonly kind: ResponsysErrorKind,
    readonly status?: number,
    readonly retryAfterSec?: number
  ) {
    super(message);
  }
  get retryable() {
    return ['rate_limited', 'server', 'timeout', 'network'].includes(this.kind);
  }
}

export interface ResponsysCredentials {
  username: string;
  password: string;
}

export interface ClientOptions {
  loginBaseUrl: string;
  credentials: ResponsysCredentials;
  allowedHostSuffixes: string[];
  /** Test-only escape hatch for a local contract server; never set by the production factory. */
  allowInsecureLocalhost?: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  now?: () => number;
}

export const REPORTING_ROW_CEILING = 10_000;
export const REPORTING_MAX_SPAN_DAYS = 30;
const TOKEN_TTL_MS = 2 * 3600_000;
const REFRESH_MARGIN_MS = 15 * 60_000;

/** Destinations for credentials/tokens must be HTTPS hosts on the configured allowlist. */
export function validateEndpoint(raw: string, suffixes: string[], allowInsecureLocalhost = false): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ResponsysError('The Responsys endpoint is not a valid URL', 'unsafe_endpoint');
  }
  const local = allowInsecureLocalhost && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
  if (u.username || u.password) throw new ResponsysError('Endpoint URLs must not contain credentials', 'unsafe_endpoint');
  if (local) return u;
  if (u.protocol !== 'https:') throw new ResponsysError('Responsys endpoints must use HTTPS', 'unsafe_endpoint');
  const host = u.hostname.toLowerCase();
  if (!suffixes.some((s) => host === s.replace(/^\./, '') || host.endsWith(s.startsWith('.') ? s : `.${s}`))) {
    throw new ResponsysError(`Host ${host} is not on the approved Responsys host list`, 'unsafe_endpoint');
  }
  return u;
}

const pad = (n: number) => String(n).padStart(2, '0');
/** 'YYYY-MM-DD' → 'MM-DD-YYYY' (Connect job-run filters). */
export function toConnectDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${m}-${d}-${y}`;
}

export class ResponsysClient {
  private token: string | null = null;
  private endpoint: URL | null = null;
  private issuedAtMs = 0;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly opts: ClientOptions) {
    validateEndpoint(opts.loginBaseUrl, opts.allowedHostSuffixes, opts.allowInsecureLocalhost);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  get serviceEndpoint(): string | null {
    return this.endpoint?.origin ?? null;
  }

  private async send(url: URL, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000) });
    } catch (e) {
      const err = e as Error & { cause?: { code?: string } };
      if (err.name === 'TimeoutError' || err.name === 'AbortError') throw new ResponsysError('Responsys did not respond in time', 'timeout');
      const code = err.cause?.code && /^[A-Z0-9_]{1,60}$/.test(err.cause.code) ? err.cause.code : 'NETWORK_ERROR';
      const reason = code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT' ? 'Connection to the Responsys HTTPS endpoint timed out before authentication. Verify the WS End Point, VPN/proxy and outbound port 443.'
        : code === 'ENOTFOUND' || code === 'EAI_AGAIN' ? 'The Responsys hostname could not be resolved. Verify the WS End Point and DNS connection.'
        : /CERT|TLS|SSL/.test(code) ? 'TLS certificate validation failed. Check the server trust store or corporate proxy certificate with your IT administrator.'
        : code === 'ECONNREFUSED' ? 'The Responsys endpoint refused the HTTPS connection. Verify the hostname and network access.'
        : 'The server could not establish an HTTPS connection to Responsys. Check the endpoint and network access.';
      throw new ResponsysError(`${code}: ${reason}`, 'network');
    }
  }

  async authenticate(): Promise<void> {
    const login = validateEndpoint(this.opts.loginBaseUrl, this.opts.allowedHostSuffixes, this.opts.allowInsecureLocalhost);
    const body = new URLSearchParams({ user_name: this.opts.credentials.username, password: this.opts.credentials.password, auth_type: 'password' });
    const res = await this.send(new URL('/rest/api/v1.3/auth/token', login), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
    });
    if (res.status === 401 || res.status === 400 || res.status === 403) throw new ResponsysError('Responsys rejected the API credentials', 'auth', res.status);
    if (!res.ok) throw await classify(res);
    const json = (await res.json().catch(() => null)) as { authToken?: unknown; endPoint?: unknown; issuedAt?: unknown } | null;
    if (!json || typeof json.authToken !== 'string' || typeof json.endPoint !== 'string') {
      throw new ResponsysError('Unexpected authentication response (no authToken/endPoint)', 'invalid_response');
    }
    // Tokens are only ever sent to an approved HTTPS host returned by the login service.
    this.endpoint = validateEndpoint(json.endPoint, this.opts.allowedHostSuffixes, this.opts.allowInsecureLocalhost);
    this.token = json.authToken;
    this.issuedAtMs = typeof json.issuedAt === 'number' ? json.issuedAt : this.now();
  }

  private tokenFresh() {
    return this.token && this.now() - this.issuedAtMs < TOKEN_TTL_MS - REFRESH_MARGIN_MS;
  }

  private async request(method: string, path: string, opts: { query?: Record<string, string>; json?: unknown } = {}, retried = false): Promise<Response> {
    if (!this.tokenFresh()) await this.authenticate();
    const url = new URL(path, this.endpoint!);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    const res = await this.send(url, {
      method,
      headers: { Authorization: this.token!, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: opts.json === undefined ? undefined : JSON.stringify(opts.json),
    });
    if (res.status === 401 && !retried) {
      const failure = await classify(res.clone());
      if (failure.kind === 'permission') throw failure;
      // Token revoked or expired early: re-authenticate exactly once, never loop.
      this.token = null;
      return this.request(method, path, opts, true);
    }
    if (!res.ok && res.status !== 202) throw await classify(res);
    return res;
  }

  private async json<T>(res: Response): Promise<T> {
    const bytes = await readBounded(res, this.opts.maxResponseBytes ?? 20 * 1024 * 1024);
    try {
      return JSON.parse(bytes.toString('utf8')) as T;
    } catch {
      throw new ResponsysError('Responsys returned a response that is not JSON', 'invalid_response', res.status);
    }
  }

  async getRateLimits(): Promise<unknown> {
    return this.json(await this.request('GET', '/rest/api/ratelimit'));
  }

  async listCampaigns(limit = 200, offset = 0): Promise<Record<string, unknown>[]> {
    const body = await this.json<Record<string, unknown>>(await this.request('GET', '/rest/api/v1.3/campaigns', { query: { limit: String(limit), offset: String(offset) } }));
    const list = (body.campaigns ?? body.items ?? []) as unknown;
    if (!Array.isArray(list)) throw new ResponsysError('Unexpected campaigns response', 'invalid_response');
    return list as Record<string, unknown>[];
  }

  async listConnectJobs(): Promise<Record<string, unknown>[]> {
    const body = await this.json<unknown>(await this.request('GET', '/rest/api/v1.3/connectJobs'));
    const list = Array.isArray(body) ? body : ((body as Record<string, unknown>)?.connectJobs ?? (body as Record<string, unknown>)?.jobs);
    if (!Array.isArray(list)) throw new ResponsysError('Unexpected Connect jobs response', 'invalid_response');
    return list as Record<string, unknown>[];
  }

  async listJobRuns(jobId: string, fromIso: string, toIso: string): Promise<Record<string, unknown>[]> {
    const body = await this.json<unknown>(
      await this.request('GET', `/rest/api/v1.3/connectJobs/${encodeURIComponent(jobId)}/jobRuns`, { query: { sdate: toConnectDate(fromIso), edate: toConnectDate(toIso) } })
    );
    const list = Array.isArray(body) ? body : ((body as Record<string, unknown>)?.jobRuns ?? (body as Record<string, unknown>)?.runs);
    if (!Array.isArray(list)) throw new ResponsysError('Unexpected Connect job runs response', 'invalid_response');
    return list as Record<string, unknown>[];
  }

  async getJobRunStatus(jobId: string, runId: string): Promise<Record<string, unknown>> {
    return this.json(await this.request('GET', `/rest/api/v1.3/connectJobs/${encodeURIComponent(jobId)}/jobRuns/${encodeURIComponent(runId)}/status`));
  }

  redactDiagnostic(value: unknown): string {
    let text = String(value ?? '');
    for (const secret of [this.opts.credentials.password, this.opts.credentials.username, this.token].filter((v): v is string => Boolean(v))) text = text.split(secret).join('[redacted]');
    return text.replace(/\b(password|authToken|authorization|token|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email redacted]').slice(0, 2000);
  }

  async getJobRunLogs(jobId: string, runId: string): Promise<{ logLevel: string; logMessage: string; logTime: string | number | null }[]> {
    const body = await this.json<unknown>(await this.request('GET', `/rest/api/v1.3/connectJobs/${encodeURIComponent(jobId)}/jobRuns/${encodeURIComponent(runId)}/logs`));
    const list = Array.isArray(body) ? body : (body as Record<string, unknown>)?.logs;
    if (!Array.isArray(list)) throw new ResponsysError('Unexpected Connect logs response', 'invalid_response');
    const rows = list.filter(v => v && typeof v === 'object').map(v => {
      const rawTime = typeof v.logTime === 'string' || typeof v.logTime === 'number' ? v.logTime : null;
      const time = rawTime === null ? NaN : typeof rawTime === 'number' || /^\d{13}$/.test(rawTime) ? Number(rawTime) : Date.parse(rawTime);
      return { logLevel: String(v.logLevel ?? 'INFO').slice(0, 30), logMessage: this.redactDiagnostic(v.logMessage), logTime: Number.isFinite(time) && !Number.isNaN(new Date(time).getTime()) ? new Date(time).toISOString() : null };
    });
    return rows.sort((a,b) => (a.logTime ?? '').localeCompare(b.logTime ?? '')).slice(-50);
  }

  async createPerformanceRequest(channel: 'email' | 'sms' | 'mobileapps', range: { sendFromDate: string; sendToDate: string; campaignName?: string }): Promise<string> {
    const res = await this.request('POST', `/rest/asyncApi/v1.3/performanceAnalytics/campaigns/${channel}`, { json: range });
    const body = await this.json<{ requestId?: unknown }>(res);
    if (typeof body.requestId !== 'string' && typeof body.requestId !== 'number') throw new ResponsysError('The reporting request was not accepted (no requestId)', 'invalid_response', res.status);
    return String(body.requestId);
  }

  /** HTTP 202 (or a pending status) means accepted, not complete. */
  async pollPerformanceRequest(requestId: string): Promise<{ state: 'pending' } | { state: 'complete'; payload: unknown; bytes: number }> {
    const res = await this.request('GET', `/rest/asyncApi/v1.3/performanceAnalytics/requests/${encodeURIComponent(requestId)}`);
    if (res.status === 202) return { state: 'pending' };
    let bytes = await readBounded(res, this.opts.maxResponseBytes ?? 20 * 1024 * 1024);
    const flagged = /gzip/i.test(res.headers.get('responsys-content-encoding') ?? '');
    // Decode exactly once: either flagged by Responsys or still carrying the gzip magic bytes
    // (a client that already decoded transport compression leaves plain JSON).
    if (flagged || (bytes[0] === 0x1f && bytes[1] === 0x8b)) {
      try {
        bytes = gunzipSync(bytes, { maxOutputLength: this.opts.maxResponseBytes ?? 100 * 1024 * 1024 });
      } catch (e) {
        if (!(flagged && bytes[0] === 0x7b)) throw new ResponsysError(`Could not decompress the reporting result: ${(e as Error).message}`, 'invalid_response');
      }
    }
    let payload: unknown;
    try {
      payload = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new ResponsysError('The reporting result is not valid JSON', 'invalid_response');
    }
    const status = String((payload as Record<string, unknown>)?.status ?? '').toUpperCase();
    if (['PENDING', 'IN_PROGRESS', 'RUNNING', 'SUBMITTED', 'QUEUED'].includes(status)) return { state: 'pending' };
    if (['FAILED', 'ERROR'].includes(status)) throw new ResponsysError(`Responsys reported the request as ${status}`, 'server');
    return { state: 'complete', payload, bytes: bytes.length };
  }
}

async function readBounded(res: Response, max: number): Promise<Buffer> {
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > max) throw new ResponsysError('The Responsys response is larger than the allowed limit', 'invalid_response');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > max) throw new ResponsysError('The Responsys response is larger than the allowed limit', 'invalid_response');
  return buf;
}

async function classify(res: Response): Promise<ResponsysError> {
  const s = res.status;
  const body = await res.json().catch(() => null) as { errorCode?: unknown } | null;
  const code = typeof body?.errorCode === 'string' && /^[A-Z0-9_]{1,100}$/.test(body.errorCode) ? body.errorCode : null;
  if (code === 'API_DISABLED_FOR_USER' || code === 'CONNECT_DISABLED_FOR_USER') return new ResponsysError(`${code}: Ask your Responsys administrator to enable this API capability for the API user`, 'permission', s);
  if (s === 401) return new ResponsysError('Responsys authentication failed', 'auth', s);
  if (s === 403) return new ResponsysError('The API user is not permitted to use this operation', 'permission', s);
  if (s === 404) return new ResponsysError('Not found in Responsys', 'not_found', s);
  if (s === 429) {
    const header = res.headers.get('retry-after');
    const ra = header && !/^\d+$/.test(header) ? Math.ceil((Date.parse(header) - Date.now()) / 1000) : Number(header);
    return new ResponsysError('Responsys rate limit reached', 'rate_limited', s, Number.isFinite(ra) && ra > 0 ? ra : undefined);
  }
  if (s >= 500) return new ResponsysError(`Responsys server error (${s})`, 'server', s);
  return new ResponsysError(`Unexpected Responsys response (${s})`, 'invalid_response', s);
}

// ---------------------------------------------------------------- reporting rows
const ROW_ALIASES: Record<string, string[]> = {
  campaignName: ['campaignname', 'campaign', 'name'],
  campaignId: ['campaignid'],
  launchId: ['launchid'],
  launchDate: ['launchdate', 'senddate', 'sentdate', 'launchtime'],
  sent: ['sent', 'totalsent'],
  delivered: ['delivered', 'totaldelivered'],
  bounces: ['bounced', 'bounces', 'totalbounced'],
  totalOpens: ['totalopens', 'opened'],
  uniqueOpens: ['uniqueopens'],
  totalClicks: ['totalclicks', 'clicked'],
  uniqueClicks: ['uniqueclicks'],
  conversionEvents: ['conversions', 'totalconversions'],
  revenue: ['revenue', 'totalrevenue'],
  unsubscribes: ['unsubscribes', 'optouts', 'optedout'],
  complaints: ['complaints'],
};

export interface ReportingRow {
  campaignName: string;
  campaignId: string | null;
  launchId: string | null;
  launchDate: string;
  measures: Record<string, string | null>;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Maps reporting rows only when identity and date fields are recognisable. Unknown shapes are
 * rejected (the partition fails with an explicit reason) instead of being guessed.
 */
export function extractReportingRows(payload: unknown): { rows: ReportingRow[]; unknownShape: boolean } {
  const findArray = (v: unknown, depth = 0): Record<string, unknown>[] | null => {
    if (Array.isArray(v)) return v.every((x) => x && typeof x === 'object') ? (v as Record<string, unknown>[]) : null;
    if (v && typeof v === 'object' && depth < 3) for (const x of Object.values(v)) {
      const a = findArray(x, depth + 1);
      if (a) return a;
    }
    return null;
  };
  const list = findArray(payload);
  if (!list) return { rows: [], unknownShape: true };
  const rows: ReportingRow[] = [];
  for (const raw of list) {
    const byNorm = new Map(Object.entries(raw).map(([k, v]) => [norm(k), v]));
    const get = (field: string) => {
      for (const a of ROW_ALIASES[field]!) if (byNorm.has(a)) return byNorm.get(a);
      return undefined;
    };
    const name = get('campaignName');
    const date = String(get('launchDate') ?? '').slice(0, 10);
    if (typeof name !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return { rows: [], unknownShape: true };
    const measures: Record<string, string | null> = {};
    for (const f of ['sent', 'delivered', 'bounces', 'totalOpens', 'uniqueOpens', 'totalClicks', 'uniqueClicks', 'conversionEvents', 'revenue', 'unsubscribes', 'complaints']) {
      const v = get(f);
      measures[f] = v === undefined || v === null || v === '' ? null : /^-?\d+(\.\d+)?$/.test(String(v)) ? String(v) : null;
    }
    const id = get('campaignId');
    const launch = get('launchId');
    rows.push({ campaignName: name, campaignId: id === undefined ? null : String(id), launchId: launch === undefined ? null : String(launch), launchDate: date, measures });
  }
  return { rows, unknownShape: false };
}

// ---------------------------------------------------------------- credentials & factory
export function resolveCredentials(cfg: AppConfig, ref: string): ResponsysCredentials {
  const [kind, name] = ref.split(':') as [string, string];
  if (kind === 'env') {
    const key = name.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    const username = process.env[`RESPONSYS_${key}_USERNAME`];
    const password = process.env[`RESPONSYS_${key}_PASSWORD`];
    if (username && password) return { username, password };
  } else if (kind === 'file' && cfg.RESPONSYS_CREDENTIALS_FILE) {
    try {
      const all = JSON.parse(readFileSync(cfg.RESPONSYS_CREDENTIALS_FILE, 'utf8')) as Record<string, ResponsysCredentials>;
      const c = all[name];
      if (c?.username && c?.password) return { username: c.username, password: c.password };
    } catch {
      // fall through to the generic error (never echo file contents)
    }
  }
  throw new ResponsysError(`No credentials are available for reference "${ref}" on the server`, 'credentials_missing');
}

export type ResponsysClientFactory = (conn: { loginBaseUrl: string; credentialRef: string }) => ResponsysClient;

export function createResponsysFactory(cfg: AppConfig): ResponsysClientFactory {
  return (conn) =>
    new ResponsysClient({
      loginBaseUrl: conn.loginBaseUrl,
      credentials: resolveCredentials(cfg, conn.credentialRef),
      allowedHostSuffixes: cfg.responsysAllowedHostSuffixes,
    });
}

export { pad };
