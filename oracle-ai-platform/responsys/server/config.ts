/**
 * Runtime configuration, validated once at startup.
 *
 * Production refuses insecure or development-only settings. Optional integrations
 * (AI, Responsys) never block startup when unconfigured.
 */
import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0', ''])
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v === 'true' || v === '1'));

const intIn = (def: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === '') return def;
      if (!/^\d+$/.test(v.trim())) {
        ctx.addIssue({ code: 'custom', message: `expected an integer, got "${v}"` });
        return z.NEVER;
      }
      const n = Number(v);
      if (n < min || n > max) {
        ctx.addIssue({ code: 'custom', message: `must be between ${min} and ${max}` });
        return z.NEVER;
      }
      return n;
    });

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  APP_DATA_MODE: z.enum(['production', 'development', 'demo', 'test']).default('development'),
  PORT: intIn(3000, 1, 65535),
  APP_BASE_URL: z.string().url().default('http://localhost:3000'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_MIGRATION_URL: z.string().optional(),
  // Set when the login is the schema owner (managed databases): each transaction switches to this role.
  DATABASE_RUNTIME_ROLE: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/).optional(),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  SESSION_TTL_HOURS: intIn(12, 1, 24 * 30),

  AUTH_MODE: z.enum(['oidc', 'dev']).default('oidc'),
  OIDC_ISSUER_URL: z.string().optional().default(''),
  OIDC_CLIENT_ID: z.string().optional().default(''),
  OIDC_CLIENT_SECRET: z.string().optional().default(''),
  ALLOW_WORKSPACE_CREATION: bool(false),
  // Optional sign-in allow-list: comma-separated emails and/or @domain entries. Empty = any verified account.
  ALLOWED_SIGNIN_EMAILS: z.string().optional().default(''),

  STORAGE_DRIVER: z.enum(['filesystem', 'netlify_blobs']).default('filesystem'),
  STORAGE_ROOT: z.string().default('./var/objects'),
  UPLOAD_MAX_BYTES: intIn(10 * 1024 * 1024, 1024, 200 * 1024 * 1024),

  AI_PROVIDER: z.enum(['none', 'gemini', 'nvidia', 'openai']).default('none'),
  AI_MODEL: z.string().optional().default(''),
  /** Optional second model, tried only when AI_MODEL is busy, over quota or unavailable. */
  AI_FALLBACK_MODEL: z.string().regex(/^[A-Za-z0-9._-]*$/, 'AI_FALLBACK_MODEL must be a model name').optional().default(''),
  GEMINI_API_KEY: z.string().optional().default(''),
  /**
   * OpenAI-compatible ChatGPT provider. Used as the main provider with AI_PROVIDER=openai.
   */
  OPENAI_API_KEY: z.string().optional().default(''),
  OPENAI_MODEL: z.string().regex(/^[A-Za-z0-9._\/:-]*$/, 'OPENAI_MODEL must be a model id').optional().default(''),
  OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  /**
   * NVIDIA API catalog (OpenAI-compatible chat completions). Used as the main provider with
   * AI_PROVIDER=nvidia, or — when AI_PROVIDER=gemini and both values are set — as the backup when
   * Gemini is busy, over quota or unavailable.
   */
  NVIDIA_API_KEY: z.string().optional().default(''),
  NVIDIA_MODEL: z.string().regex(/^[A-Za-z0-9._\/:-]*$/, 'NVIDIA_MODEL must be a model id').optional().default(''),
  NVIDIA_BASE_URL: z.string().url().default('https://integrate.api.nvidia.com/v1'),
  AI_TIMEOUT_MS: intIn(90000, 1000, 300000),
  AI_MAX_OUTPUT_TOKENS: intIn(8192, 100, 65536),
  AI_DAILY_RUN_LIMIT_PER_WORKSPACE: intIn(200, 0, 100000),

  RESPONSYS_ALLOWED_HOST_SUFFIXES: z.string().default('.responsys.net,.responsys.ocs.oraclecloud.com'),
  RESPONSYS_CREDENTIALS_FILE: z.string().optional().default(''),
  SYNC_METADATA_INTERVAL_MINUTES: intIn(15, 1, 1440),
  SYNC_REPORTING_INTERVAL_MINUTES: intIn(15, 1, 1440),
  SYNC_RECONCILIATION_LOOKBACK_DAYS: intIn(14, 0, 365),

  ENABLE_PROVIDER_DRAFT_WRITES: bool(false),
  ENABLE_PROOF_SENDS: bool(false),
  ENABLE_LIVE_CAMPAIGN_SENDS: bool(false),

  RUN_WORKER_IN_PROCESS: bool(false),
  // sse: long-lived stream; poll: short requests only (serverless hosts).
  LIVE_UPDATES: z.enum(['sse', 'poll']).default('sse'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type AppConfig = z.infer<typeof EnvSchema> & {
  isProduction: boolean;
  signinAllowList: string[];
  cookieSecure: boolean;
  responsysAllowedHostSuffixes: string[];
};

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`Invalid configuration: ${details}`);
  }
  const c = parsed.data;
  const isProduction = c.NODE_ENV === 'production';
  const problems: string[] = [];

  if (isProduction || c.APP_DATA_MODE === 'production') {
    if (c.AUTH_MODE === 'dev') problems.push('AUTH_MODE=dev (local identity harness) is not allowed in production');
    if (c.AUTH_MODE === 'oidc' && (!c.OIDC_ISSUER_URL || !c.OIDC_CLIENT_ID)) {
      problems.push('OIDC_ISSUER_URL and OIDC_CLIENT_ID are required in production');
    }
    if (!c.APP_BASE_URL.startsWith('https://')) problems.push('APP_BASE_URL must use https in production');
    if (/change-me|development|dev-secret/i.test(c.SESSION_SECRET)) problems.push('SESSION_SECRET looks like a development default');
  }
  if (isProduction && c.APP_DATA_MODE !== 'production') {
    problems.push(`APP_DATA_MODE=${c.APP_DATA_MODE} cannot run with NODE_ENV=production`);
  }
  if (c.APP_DATA_MODE === 'production' && c.NODE_ENV !== 'production') {
    problems.push('APP_DATA_MODE=production requires NODE_ENV=production');
  }
  if (c.AI_PROVIDER === 'gemini' && (!c.AI_MODEL || !c.GEMINI_API_KEY)) {
    problems.push('AI_PROVIDER=gemini requires AI_MODEL and GEMINI_API_KEY (no default model is assumed)');
  }
  if (c.AI_PROVIDER === 'openai' && (!c.OPENAI_MODEL || !c.OPENAI_API_KEY)) {
    problems.push('AI_PROVIDER=openai requires OPENAI_MODEL and OPENAI_API_KEY');
  }
  if (c.AI_PROVIDER === 'nvidia' && (!c.NVIDIA_MODEL || !c.NVIDIA_API_KEY)) {
    problems.push('AI_PROVIDER=nvidia requires NVIDIA_MODEL and NVIDIA_API_KEY');
  }
  if (isProduction && c.OPENAI_API_KEY && !c.OPENAI_BASE_URL.startsWith('https://')) {
    problems.push('OPENAI_BASE_URL must use https in production');
  }
  if (isProduction && c.NVIDIA_API_KEY && !c.NVIDIA_BASE_URL.startsWith('https://')) {
    problems.push('NVIDIA_BASE_URL must use https in production');
  }
  if (c.AUTH_MODE === 'oidc' && !isProduction && (!c.OIDC_ISSUER_URL || !c.OIDC_CLIENT_ID)) {
    problems.push('AUTH_MODE=oidc requires OIDC_ISSUER_URL and OIDC_CLIENT_ID (use AUTH_MODE=dev for local development)');
  }
  if (problems.length) throw new ConfigError(`Refusing to start: ${problems.join('; ')}`);

  return {
    ...c,
    isProduction,
    cookieSecure: c.APP_BASE_URL.startsWith('https://'),
    signinAllowList: c.ALLOWED_SIGNIN_EMAILS.split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    responsysAllowedHostSuffixes: c.RESPONSYS_ALLOWED_HOST_SUFFIXES.split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  };
}

/** True when the allow-list is empty or names this email or its @domain. */
export function isSigninAllowed(cfg: Pick<AppConfig, 'signinAllowList'>, email: string): boolean {
  if (!cfg.signinAllowList.length) return true;
  const e = email.trim().toLowerCase();
  const domain = e.slice(e.lastIndexOf('@'));
  return cfg.signinAllowList.some((a) => a === e || (a.startsWith('@') && a === domain));
}
