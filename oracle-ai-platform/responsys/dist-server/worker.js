// server/runtime.ts
import dotenv from "dotenv";

// server/config.ts
import { z } from "zod";
var bool = (def) => z.enum(["true", "false", "1", "0", ""]).optional().transform((v) => v === void 0 || v === "" ? def : v === "true" || v === "1");
var intIn = (def, min, max) => z.string().optional().transform((v, ctx) => {
  if (v === void 0 || v.trim() === "") return def;
  if (!/^\d+$/.test(v.trim())) {
    ctx.addIssue({ code: "custom", message: `expected an integer, got "${v}"` });
    return z.NEVER;
  }
  const n = Number(v);
  if (n < min || n > max) {
    ctx.addIssue({ code: "custom", message: `must be between ${min} and ${max}` });
    return z.NEVER;
  }
  return n;
});
var EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  APP_DATA_MODE: z.enum(["production", "development", "demo", "test"]).default("development"),
  PORT: intIn(3e3, 1, 65535),
  APP_BASE_URL: z.string().url().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DATABASE_MIGRATION_URL: z.string().optional(),
  // Set when the login is the schema owner (managed databases): each transaction switches to this role.
  DATABASE_RUNTIME_ROLE: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/).optional(),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
  SESSION_TTL_HOURS: intIn(12, 1, 24 * 30),
  AUTH_MODE: z.enum(["oidc", "dev"]).default("oidc"),
  OIDC_ISSUER_URL: z.string().optional().default(""),
  OIDC_CLIENT_ID: z.string().optional().default(""),
  OIDC_CLIENT_SECRET: z.string().optional().default(""),
  ALLOW_WORKSPACE_CREATION: bool(false),
  // Optional sign-in allow-list: comma-separated emails and/or @domain entries. Empty = any verified account.
  ALLOWED_SIGNIN_EMAILS: z.string().optional().default(""),
  STORAGE_DRIVER: z.enum(["filesystem", "netlify_blobs"]).default("filesystem"),
  STORAGE_ROOT: z.string().default("./var/objects"),
  UPLOAD_MAX_BYTES: intIn(10 * 1024 * 1024, 1024, 200 * 1024 * 1024),
  AI_PROVIDER: z.enum(["none", "gemini", "nvidia", "openai"]).default("none"),
  AI_MODEL: z.string().optional().default(""),
  /** Optional second model, tried only when AI_MODEL is busy, over quota or unavailable. */
  AI_FALLBACK_MODEL: z.string().regex(/^[A-Za-z0-9._-]*$/, "AI_FALLBACK_MODEL must be a model name").optional().default(""),
  GEMINI_API_KEY: z.string().optional().default(""),
  /**
   * OpenAI-compatible ChatGPT provider. Used as the main provider with AI_PROVIDER=openai.
   */
  OPENAI_API_KEY: z.string().optional().default(""),
  OPENAI_MODEL: z.string().regex(/^[A-Za-z0-9._\/:-]*$/, "OPENAI_MODEL must be a model id").optional().default(""),
  OPENAI_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  /**
   * NVIDIA API catalog (OpenAI-compatible chat completions). Used as the main provider with
   * AI_PROVIDER=nvidia, or — when AI_PROVIDER=gemini and both values are set — as the backup when
   * Gemini is busy, over quota or unavailable.
   */
  NVIDIA_API_KEY: z.string().optional().default(""),
  NVIDIA_MODEL: z.string().regex(/^[A-Za-z0-9._\/:-]*$/, "NVIDIA_MODEL must be a model id").optional().default(""),
  NVIDIA_BASE_URL: z.string().url().default("https://integrate.api.nvidia.com/v1"),
  AI_TIMEOUT_MS: intIn(9e4, 1e3, 3e5),
  AI_MAX_OUTPUT_TOKENS: intIn(8192, 100, 65536),
  AI_DAILY_RUN_LIMIT_PER_WORKSPACE: intIn(200, 0, 1e5),
  RESPONSYS_ALLOWED_HOST_SUFFIXES: z.string().default(".responsys.net,.responsys.ocs.oraclecloud.com"),
  RESPONSYS_CREDENTIALS_FILE: z.string().optional().default(""),
  SYNC_METADATA_INTERVAL_MINUTES: intIn(15, 1, 1440),
  SYNC_REPORTING_INTERVAL_MINUTES: intIn(15, 1, 1440),
  SYNC_RECONCILIATION_LOOKBACK_DAYS: intIn(14, 0, 365),
  ENABLE_PROVIDER_DRAFT_WRITES: bool(false),
  ENABLE_PROOF_SENDS: bool(false),
  ENABLE_LIVE_CAMPAIGN_SENDS: bool(false),
  RUN_WORKER_IN_PROCESS: bool(false),
  // sse: long-lived stream; poll: short requests only (serverless hosts).
  LIVE_UPDATES: z.enum(["sse", "poll"]).default("sse"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info")
});
var ConfigError = class extends Error {
};
function loadConfig(env = process.env) {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new ConfigError(`Invalid configuration: ${details}`);
  }
  const c = parsed.data;
  const isProduction = c.NODE_ENV === "production";
  const problems = [];
  if (isProduction || c.APP_DATA_MODE === "production") {
    if (c.AUTH_MODE === "dev") problems.push("AUTH_MODE=dev (local identity harness) is not allowed in production");
    if (c.AUTH_MODE === "oidc" && (!c.OIDC_ISSUER_URL || !c.OIDC_CLIENT_ID)) {
      problems.push("OIDC_ISSUER_URL and OIDC_CLIENT_ID are required in production");
    }
    if (!c.APP_BASE_URL.startsWith("https://")) problems.push("APP_BASE_URL must use https in production");
    if (/change-me|development|dev-secret/i.test(c.SESSION_SECRET)) problems.push("SESSION_SECRET looks like a development default");
  }
  if (isProduction && c.APP_DATA_MODE !== "production") {
    problems.push(`APP_DATA_MODE=${c.APP_DATA_MODE} cannot run with NODE_ENV=production`);
  }
  if (c.APP_DATA_MODE === "production" && c.NODE_ENV !== "production") {
    problems.push("APP_DATA_MODE=production requires NODE_ENV=production");
  }
  if (c.AI_PROVIDER === "gemini" && (!c.AI_MODEL || !c.GEMINI_API_KEY)) {
    problems.push("AI_PROVIDER=gemini requires AI_MODEL and GEMINI_API_KEY (no default model is assumed)");
  }
  if (c.AI_PROVIDER === "openai" && (!c.OPENAI_MODEL || !c.OPENAI_API_KEY)) {
    problems.push("AI_PROVIDER=openai requires OPENAI_MODEL and OPENAI_API_KEY");
  }
  if (c.AI_PROVIDER === "nvidia" && (!c.NVIDIA_MODEL || !c.NVIDIA_API_KEY)) {
    problems.push("AI_PROVIDER=nvidia requires NVIDIA_MODEL and NVIDIA_API_KEY");
  }
  if (isProduction && c.OPENAI_API_KEY && !c.OPENAI_BASE_URL.startsWith("https://")) {
    problems.push("OPENAI_BASE_URL must use https in production");
  }
  if (isProduction && c.NVIDIA_API_KEY && !c.NVIDIA_BASE_URL.startsWith("https://")) {
    problems.push("NVIDIA_BASE_URL must use https in production");
  }
  if (c.AUTH_MODE === "oidc" && !isProduction && (!c.OIDC_ISSUER_URL || !c.OIDC_CLIENT_ID)) {
    problems.push("AUTH_MODE=oidc requires OIDC_ISSUER_URL and OIDC_CLIENT_ID (use AUTH_MODE=dev for local development)");
  }
  if (problems.length) throw new ConfigError(`Refusing to start: ${problems.join("; ")}`);
  return {
    ...c,
    isProduction,
    cookieSecure: c.APP_BASE_URL.startsWith("https://"),
    signinAllowList: c.ALLOWED_SIGNIN_EMAILS.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    responsysAllowedHostSuffixes: c.RESPONSYS_ALLOWED_HOST_SUFFIXES.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
  };
}

// server/db/pool.ts
import pg from "pg";
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => v);
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => v);
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);
var ROLE_RE = /^[a-z_][a-z0-9_]{0,62}$/;
var Db = class {
  pool;
  runtimeRole;
  constructor(connectionString, max = 10, opts = {}) {
    if (opts.runtimeRole && !ROLE_RE.test(opts.runtimeRole)) throw new Error("Invalid runtime role name");
    this.runtimeRole = opts.runtimeRole || null;
    this.pool = new pg.Pool({ connectionString, max, statement_timeout: 3e4, idle_in_transaction_session_timeout: 6e4 });
  }
  /** One statement outside tenant context (system functions, health). Runs as the runtime role. */
  async query(sql, params = []) {
    if (!this.runtimeRole) return this.pool.query(sql, params);
    return this.transaction(null, (tx) => tx.query(sql, params));
  }
  /** Transaction without tenant context: only identity tables (users, sessions) are visible. */
  async withSystem(fn) {
    return this.transaction(null, fn);
  }
  /** Transaction scoped to one user (sees only that user's memberships/workspaces). */
  async withUser(userId, fn) {
    return this.transaction({ userId }, fn);
  }
  async withTenant(ctx, fn) {
    if (!ctx.workspaceId) throw new Error("withTenant requires a workspaceId");
    return this.transaction(ctx, fn);
  }
  async transaction(ctx, fn) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (this.runtimeRole) await client.query(`SET LOCAL ROLE ${this.runtimeRole}`);
      if (ctx?.workspaceId) await client.query(`SELECT set_config('app.workspace_id', $1, true)`, [ctx.workspaceId]);
      if (ctx?.userId) await client.query(`SELECT set_config('app.user_id', $1, true)`, [ctx.userId]);
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => void 0);
      throw err;
    } finally {
      client.release();
    }
  }
  async ping() {
    try {
      await this.pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }
  /** Refuse to run the application as a role that would bypass row-level security. */
  async assertRuntimeRoleIsSafe() {
    const { rows } = await this.query(
      `SELECT r.rolname, r.rolsuper, r.rolbypassrls,
              EXISTS (SELECT 1 FROM pg_tables t WHERE t.schemaname = 'public' AND t.tablename = 'accounts' AND t.tableowner = r.rolname) AS owns
         FROM pg_roles r WHERE r.rolname = current_user`
    );
    const r = rows[0];
    if (!r) throw new Error("Could not inspect the database role");
    if (r.rolsuper || r.rolbypassrls || r.owns) {
      throw new Error(
        `Database role "${r.rolname}" bypasses row-level security (superuser, BYPASSRLS, or table owner). Connect the application as the non-owner runtime role (rci_app).`
      );
    }
  }
  async close() {
    await this.pool.end();
  }
};

// server/integrations/storage/storage.ts
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
var KEY_RE = /^[0-9a-f-]{36}\/[a-z_]{1,32}\/[0-9a-f-]{36}$/;
var FilesystemStorage = class {
  root;
  constructor(root) {
    this.root = path.resolve(root);
  }
  pathFor(key) {
    if (!KEY_RE.test(key)) throw new Error("Invalid storage key");
    const p = path.resolve(this.root, key);
    if (!p.startsWith(this.root + path.sep)) throw new Error("Invalid storage key");
    return p;
  }
  async put(workspaceId, kind, bytes) {
    const key = `${workspaceId}/${kind}/${randomUUID()}`;
    const target = this.pathFor(key);
    await mkdir(path.dirname(target), { recursive: true, mode: 448 });
    const tmp = `${target}.tmp-${process.pid}`;
    await writeFile(tmp, bytes, { mode: 384, flag: "wx" });
    await rename(tmp, target);
    return { key, sha256: createHash("sha256").update(bytes).digest("hex"), byteSize: bytes.length };
  }
  async get(key) {
    return readFile(this.pathFor(key));
  }
  async remove(key) {
    await rm(this.pathFor(key), { force: true });
  }
  async healthy() {
    try {
      await mkdir(this.root, { recursive: true, mode: 448 });
      return (await stat(this.root)).isDirectory();
    } catch {
      return false;
    }
  }
};

// server/integrations/ai/provider.ts
import { ApiError as GenAiApiError, GoogleGenAI, ThinkingLevel } from "@google/genai";
var AiDisabledError = class extends Error {
};
var noneProvider = {
  name: "none",
  model: null,
  enabled: false,
  async generateJson() {
    throw new AiDisabledError("AI is not configured for this deployment");
  }
};
var AiCallError = class extends Error {
  constructor(message, kind, providerStatus) {
    super(message);
    this.kind = kind;
    this.providerStatus = providerStatus;
  }
  kind;
  providerStatus;
};
function providerMessage(e) {
  const raw = e instanceof Error ? e.message : String(e);
  try {
    const parsed = JSON.parse(raw);
    if (parsed.error?.message) return parsed.error.message;
  } catch {
  }
  return raw;
}
function describeAiError(e, model, timeoutMs) {
  if (e instanceof AiCallError) return e;
  const status = e instanceof GenAiApiError ? e.status : null;
  const msg = providerMessage(e).replace(/key=[^&\s]+/gi, "key=\u2026").slice(0, 400);
  const name = e instanceof Error ? e.name : "";
  if (name === "TimeoutError" || name === "AbortError" || /aborted|timed? ?out/i.test(msg)) {
    return new AiCallError(`The AI model did not answer within ${Math.round(timeoutMs / 1e3)} seconds.`, "timeout", status);
  }
  if (status === 404) return new AiCallError(`The AI model "${model}" is not available to this API key. Set AI_MODEL to a current model. Google says: ${msg}`, "model_unavailable", status);
  if (status === 401 || status === 403) return new AiCallError(`The Gemini API key was refused. Check GEMINI_API_KEY. Google says: ${msg}`, "auth", status);
  if (status === 429) {
    const wait = msg.match(/retry in ([\d.]+)\s*s/i);
    const perMinute = msg.match(/free_tier_requests, limit: (\d+)/i);
    return new AiCallError(
      `Gemini's usage limit was reached${perMinute ? ` (free tier: ${perMinute[1]} requests per minute for ${model})` : ""}. ${wait ? `Try again in about ${Math.ceil(Number(wait[1]))} seconds` : "Try again in a minute"}, or enable billing for this key in Google AI Studio for higher limits.`,
      "quota",
      status
    );
  }
  if (status === 503 || status === 500 || /high demand|overloaded/i.test(msg)) {
    return new AiCallError("Google\u2019s Gemini service is overloaded right now (high demand). This is temporary \u2014 try again in a minute.", "busy", status);
  }
  if (status === 400) return new AiCallError(`Google rejected the request. Google says: ${msg}`, "bad_request", status);
  return new AiCallError(`The AI service is unavailable. ${msg}`, "unavailable", status);
}
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function tuningFor(model) {
  if (/^gemini-([3-9]|\d{2,})/.test(model)) return { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } };
  if (/^gemini-2\.5-flash/.test(model)) return { temperature: 0.2, thinkingConfig: { thinkingBudget: 0 } };
  if (/^gemini-2/.test(model)) return { temperature: 0.2 };
  return {};
}
var GeminiProvider = class {
  constructor(model, apiKey, timeoutMs, maxOutputTokens, fallbackModel = null, maxBusyRetries = 3) {
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.maxOutputTokens = maxOutputTokens;
    this.fallbackModel = fallbackModel;
    this.maxBusyRetries = maxBusyRetries;
    this.client = new GoogleGenAI({ apiKey });
    this.primaryMs = fallbackModel && timeoutMs >= 2e4 ? Math.round(timeoutMs * 0.6) : timeoutMs;
  }
  model;
  timeoutMs;
  maxOutputTokens;
  fallbackModel;
  maxBusyRetries;
  name = "gemini";
  enabled = true;
  client;
  primaryMs;
  async call(model, req, signal, tuned) {
    return this.client.models.generateContent({
      model,
      contents: req.prompt,
      config: {
        systemInstruction: req.system,
        responseMimeType: "application/json",
        responseJsonSchema: req.jsonSchema,
        maxOutputTokens: Math.min(req.maxOutputTokens ?? this.maxOutputTokens, this.maxOutputTokens),
        ...tuned ? tuningFor(model) : {},
        abortSignal: signal
      }
    });
  }
  /** One model, with retries: without optional settings on 400, after a pause on 500/503 (overload). */
  async tryModel(model, req, signal, deadline, limitMs) {
    let tuned = true;
    let busyRetries = 0;
    for (; ; ) {
      try {
        return await this.call(model, req, signal, tuned);
      } catch (e) {
        const status = e instanceof GenAiApiError ? e.status : null;
        const left = deadline - Date.now();
        if (signal.aborted) throw describeAiError(e, model, limitMs);
        if (status === 400 && tuned) {
          tuned = false;
          continue;
        }
        if ((status === 500 || status === 503) && busyRetries < this.maxBusyRetries) {
          const pause = 1500 * 2 ** busyRetries;
          if (left > pause + 3e3) {
            busyRetries++;
            await sleep(pause);
            continue;
          }
        }
        throw describeAiError(e, model, limitMs);
      }
    }
  }
  async generateJson(req) {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    const deadline = Date.now() + this.timeoutMs;
    const firstMs = this.primaryMs;
    const firstSignal = firstMs < this.timeoutMs ? AbortSignal.any([signal, AbortSignal.timeout(firstMs)]) : signal;
    let model = this.model;
    let res;
    try {
      res = await this.tryModel(model, req, firstSignal, Math.min(deadline, Date.now() + firstMs), firstMs);
    } catch (e) {
      const err = e;
      const switchable = err.kind === "busy" || err.kind === "quota" || err.kind === "model_unavailable" || err.kind === "timeout";
      if (!this.fallbackModel || !switchable || signal.aborted || deadline - Date.now() < 2500) throw err;
      model = this.fallbackModel;
      try {
        res = await this.tryModel(model, req, signal, deadline, deadline - Date.now());
      } catch (e2) {
        const err2 = e2;
        throw new AiCallError(`${err.message} The backup model "${model}" also failed: ${err2.message}`, err2.kind, err2.providerStatus);
      }
    }
    const text = res.text ?? "";
    if (!text.trim()) throw new AiCallError("The AI model returned an empty answer.", "unavailable", null);
    return {
      text,
      model,
      inputTokens: res.usageMetadata?.promptTokenCount ?? null,
      outputTokens: res.usageMetadata?.candidatesTokenCount ?? null
    };
  }
};
function extractJson(text) {
  const t = text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  try {
    JSON.parse(t);
    return t;
  } catch {
    const a = t.indexOf("{");
    const b = t.lastIndexOf("}");
    return a >= 0 && b > a ? t.slice(a, b + 1) : t;
  }
}
function describeHttpError(status, body, label, model, keyVar, modelVar) {
  let msg = body;
  try {
    const j = JSON.parse(body);
    msg = (typeof j.error === "string" ? j.error : j.error?.message) ?? j.detail ?? j.message ?? body;
  } catch {
  }
  msg = String(msg).slice(0, 300);
  if (status === 401 || status === 403) return new AiCallError(`The ${label} API key was refused. Check ${keyVar}. ${label} says: ${msg}`, "auth", status);
  if (status === 404) return new AiCallError(`The ${label} model "${model}" is not available to this key. Set ${modelVar} to a listed model (npm run ai:models -- --nvidia). ${label} says: ${msg}`, "model_unavailable", status);
  if (status === 429) return new AiCallError(`${label}'s usage limit was reached. Try again in a minute. ${label} says: ${msg}`, "quota", status);
  if (status >= 500) return new AiCallError(`${label}'s service is overloaded or unavailable right now. Try again in a minute.`, "busy", status);
  return new AiCallError(`${label} rejected the request. ${label} says: ${msg}`, "bad_request", status);
}
function strictOutputSchema(value) {
  if (Array.isArray(value)) return value.map(strictOutputSchema);
  if (!value || typeof value !== "object") return value;
  const schema = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, strictOutputSchema(child)]));
  if (schema.type === "object" && schema.properties && typeof schema.properties === "object") {
    schema.additionalProperties = false;
    schema.required = Object.keys(schema.properties);
  }
  return schema;
}
var OpenAiCompatibleProvider = class {
  constructor(name, model, apiKey, baseUrl, timeoutMs, maxOutputTokens, fetchImpl = (...a) => fetch(...a)) {
    this.name = name;
    this.model = model;
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
    this.maxOutputTokens = maxOutputTokens;
    this.fetchImpl = fetchImpl;
  }
  name;
  model;
  apiKey;
  baseUrl;
  timeoutMs;
  maxOutputTokens;
  fetchImpl;
  enabled = true;
  label() {
    return this.name === "openai" ? "OpenAI" : "NVIDIA";
  }
  async generateJson(req) {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    const deadline = Date.now() + this.timeoutMs;
    const system = `${req.system}

Answer with exactly one JSON object and nothing else (no markdown), matching this JSON Schema:
${JSON.stringify(req.jsonSchema)}`;
    let jsonMode = true;
    let schemaMode = this.name === "openai" && req.enforceSchema === true;
    let busyRetries = 0;
    for (; ; ) {
      let res;
      try {
        res = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            model: this.model,
            messages: [
              { role: "system", content: system },
              { role: "user", content: req.prompt }
            ],
            max_tokens: Math.min(req.maxOutputTokens ?? this.maxOutputTokens, this.maxOutputTokens, 4096),
            temperature: 0.2,
            ...schemaMode ? { response_format: { type: "json_schema", json_schema: { name: "campaign_strategy", strict: true, schema: strictOutputSchema(req.jsonSchema) } } } : jsonMode ? { response_format: { type: "json_object" } } : {}
          }),
          signal
        });
      } catch (e) {
        if (signal.aborted) throw new AiCallError(`${this.label()} did not answer within ${Math.round(this.timeoutMs / 1e3)} seconds.`, "timeout", null);
        throw new AiCallError(`${this.label()} could not be reached: ${e.message}`, "unavailable", null);
      }
      if (res.ok) {
        const body = await res.json();
        const content = body.choices?.[0]?.message?.content ?? "";
        if (!content.trim()) throw new AiCallError(`${this.label()} returned an empty answer.`, "unavailable", null);
        return { text: extractJson(content), model: this.model, inputTokens: body.usage?.prompt_tokens ?? null, outputTokens: body.usage?.completion_tokens ?? null };
      }
      const text = await res.text().catch(() => "");
      if ((res.status === 400 || res.status === 422) && jsonMode) {
        if (schemaMode) {
          schemaMode = false;
          continue;
        }
        jsonMode = false;
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && busyRetries < 2 && deadline - Date.now() > 4e3) {
        busyRetries++;
        await sleep(1500 * busyRetries);
        continue;
      }
      const keyVar = this.name === "openai" ? "OPENAI_API_KEY" : "NVIDIA_API_KEY";
      const modelVar = this.name === "openai" ? "OPENAI_MODEL" : "NVIDIA_MODEL";
      throw describeHttpError(res.status, text, this.label(), this.model, keyVar, modelVar);
    }
  }
};
var ChainProvider = class {
  constructor(primary, backup, timeoutMs) {
    this.primary = primary;
    this.backup = backup;
    this.timeoutMs = timeoutMs;
  }
  primary;
  backup;
  timeoutMs;
  enabled = true;
  get name() {
    return this.primary.name;
  }
  get model() {
    return this.primary.model;
  }
  async generateJson(req) {
    const started = Date.now();
    try {
      return await this.primary.generateJson(req);
    } catch (e) {
      const err = e instanceof AiCallError ? e : null;
      const left = this.timeoutMs - (Date.now() - started);
      if (!err || !["busy", "quota", "model_unavailable", "timeout", "unavailable"].includes(err.kind) || left < 2500 || req.signal?.aborted) throw e;
      const signal = req.signal ? AbortSignal.any([req.signal, AbortSignal.timeout(left)]) : AbortSignal.timeout(left);
      try {
        return await this.backup.generateJson({ ...req, signal });
      } catch (e2) {
        throw new AiCallError(`${err.message} The backup (${this.backup.name}: ${this.backup.model}) also failed: ${e2.message}`, e2 instanceof AiCallError ? e2.kind : "unavailable", e2 instanceof AiCallError ? e2.providerStatus : null);
      }
    }
  }
};
function createAiProvider(cfg) {
  const openai = cfg.OPENAI_API_KEY && cfg.OPENAI_MODEL ? new OpenAiCompatibleProvider("openai", cfg.OPENAI_MODEL, cfg.OPENAI_API_KEY, cfg.OPENAI_BASE_URL, cfg.AI_TIMEOUT_MS, cfg.AI_MAX_OUTPUT_TOKENS) : null;
  const nvidia = cfg.NVIDIA_API_KEY && cfg.NVIDIA_MODEL ? new OpenAiCompatibleProvider("nvidia", cfg.NVIDIA_MODEL, cfg.NVIDIA_API_KEY, cfg.NVIDIA_BASE_URL, cfg.AI_TIMEOUT_MS, cfg.AI_MAX_OUTPUT_TOKENS) : null;
  if (cfg.AI_PROVIDER === "gemini") {
    const gemini = new GeminiProvider(cfg.AI_MODEL, cfg.GEMINI_API_KEY, cfg.AI_TIMEOUT_MS, cfg.AI_MAX_OUTPUT_TOKENS, cfg.AI_FALLBACK_MODEL || null, nvidia ? 1 : 3);
    return nvidia ? new ChainProvider(gemini, nvidia, cfg.AI_TIMEOUT_MS) : gemini;
  }
  if (cfg.AI_PROVIDER === "openai" && openai) return openai;
  if (cfg.AI_PROVIDER === "nvidia" && nvidia) return nvidia;
  return noneProvider;
}

// server/jobs/queue.ts
import { hostname } from "node:os";

// server/observability/logger.ts
var ORDER = { debug: 10, info: 20, warn: 30, error: 40 };
var SECRET_KEY = /pass(word)?|secret|token|authorization|cookie|api[-_]?key|credential|private/i;
var minLevel = process.env.LOG_LEVEL in ORDER ? process.env.LOG_LEVEL : "info";
var sink = (line) => process.stdout.write(line + "\n");
function configureLogger(opts) {
  if (opts.level) minLevel = opts.level;
  if (opts.sink) sink = opts.sink;
}
function redact(value, depth = 0) {
  if (depth > 5) return "[depth]";
  if (typeof value === "string") return value.length > 500 ? `${value.slice(0, 500)}\u2026[truncated]` : value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY.test(k) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}
function write(level, msg, fields) {
  if (ORDER[level] < ORDER[minLevel]) return;
  sink(JSON.stringify({ ts: (/* @__PURE__ */ new Date()).toISOString(), level, msg, ...fields ? redact(fields) : {} }));
}
var logger = {
  debug: (m, f) => write("debug", m, f),
  info: (m, f) => write("info", m, f),
  warn: (m, f) => write("warn", m, f),
  error: (m, f) => write("error", m, f)
};

// server/jobs/queue.ts
var PermanentJobError = class extends Error {
};
async function enqueueJob(tx, job) {
  const { rows } = await tx.query(
    `INSERT INTO jobs (workspace_id, type, payload, dedupe_key, max_attempts, run_after, created_by)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6, now()), $7)
     ON CONFLICT (workspace_id, dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running') DO UPDATE SET updated_at = now()
     RETURNING id`,
    [job.workspaceId, job.type, JSON.stringify(job.payload ?? {}), job.dedupeKey ?? null, job.maxAttempts ?? 5, job.runAfter ?? null, job.createdBy ?? null]
  );
  return rows[0].id;
}
function backoffMs(attempt, random = Math.random) {
  const base = Math.min(10 * 6e4, 5e3 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.75 + random() * 0.5));
}
var JobRunner = class {
  constructor(db, handlers, opts = {}) {
    this.db = db;
    this.handlers = handlers;
    this.opts = opts;
  }
  db;
  handlers;
  opts;
  workerId = `${hostname()}:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;
  stopped = false;
  loop = null;
  abort = new AbortController();
  get leaseSeconds() {
    return this.opts.leaseSeconds ?? 60;
  }
  start() {
    if (this.loop) return;
    this.loop = (async () => {
      while (!this.stopped) {
        let worked = false;
        try {
          worked = await this.runOnce();
        } catch (err) {
          logger.error("job loop error", { error: err.message });
        }
        if (!worked && !this.stopped) await new Promise((r) => setTimeout(r, this.opts.pollMs ?? 1e3));
      }
    })();
  }
  async stop() {
    this.stopped = true;
    this.abort.abort();
    await this.loop;
  }
  /** Claims and runs at most one job. Returns true when a job was processed. */
  async runOnce() {
    const types = Object.keys(this.handlers);
    const { rows } = await this.db.query("SELECT * FROM rci_claim_jobs($1, $2, 1, $3)", [this.workerId, this.leaseSeconds, types]);
    const job = rows[0];
    if (!job) return false;
    const t = { workspaceId: job.workspace_id };
    if (job.attempts > job.max_attempts) {
      await this.db.withTenant(
        t,
        (tx) => tx.query(`UPDATE jobs SET status = 'dead', finished_at = now(), updated_at = now(), locked_by = NULL WHERE id = $1`, [job.id])
      );
      logger.warn("job dead-lettered", { jobId: job.id, type: job.type, attempts: job.attempts });
      return true;
    }
    const handler = this.handlers[job.type];
    const heartbeat = async () => {
      await this.db.withTenant(
        t,
        (tx) => tx.query(`UPDATE jobs SET lease_expires_at = now() + make_interval(secs => $3), updated_at = now() WHERE id = $1 AND locked_by = $2`, [
          job.id,
          this.workerId,
          this.leaseSeconds
        ])
      );
    };
    const timer = setInterval(() => heartbeat().catch(() => void 0), Math.max(1e3, this.leaseSeconds * 1e3 / 3));
    try {
      const result = await handler(job, { db: this.db, heartbeat, signal: this.abort.signal });
      await this.db.withTenant(
        t,
        (tx) => tx.query(
          `UPDATE jobs SET status = 'succeeded', result = $2, finished_at = now(), updated_at = now(), locked_by = NULL, last_error = NULL
            WHERE id = $1 AND locked_by = $3`,
          [job.id, JSON.stringify(result ?? {}), this.workerId]
        )
      );
      logger.info("job succeeded", { jobId: job.id, type: job.type, attempts: job.attempts });
    } catch (err) {
      const message = err.message?.slice(0, 1e3) || "job failed";
      const permanent = err instanceof PermanentJobError;
      const exhausted = job.attempts >= job.max_attempts;
      const providerDelay = Number(err.retryAfterSec);
      const retryDelay = Math.max(backoffMs(job.attempts) / 1e3, Number.isFinite(providerDelay) && providerDelay > 0 ? Math.min(providerDelay, 86400) : 0);
      await this.db.withTenant(
        t,
        (tx) => permanent || exhausted ? tx.query(
          `UPDATE jobs SET status = $2, last_error = $3, finished_at = now(), updated_at = now(), locked_by = NULL WHERE id = $1`,
          [job.id, permanent ? "failed" : "dead", message]
        ) : tx.query(
          `UPDATE jobs SET status = 'queued', last_error = $2, run_after = now() + make_interval(secs => $3), updated_at = now(), locked_by = NULL WHERE id = $1`,
          [job.id, message, retryDelay]
        )
      );
      logger.warn("job failed", { jobId: job.id, type: job.type, attempts: job.attempts, permanent, exhausted, error: message });
    } finally {
      clearInterval(timer);
    }
    return true;
  }
};

// server/http/errors.ts
import { ZodError } from "zod";
var STATUS = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  payload_too_large: 413,
  invalid_request: 400,
  unprocessable: 422,
  rate_limited: 429,
  dependency_unavailable: 503,
  capability_unavailable: 503,
  internal: 500
};
var AppError = class extends Error {
  constructor(code, message, details, retryable = false) {
    super(message);
    this.code = code;
    this.details = details;
    this.retryable = retryable;
    this.status = STATUS[code];
  }
  code;
  details;
  retryable;
  status;
};
var notFound = (what = "Resource") => new AppError("not_found", `${what} not found`);

// server/modules/audit/audit.ts
async function audit(tx, actor, action, target = {}, outcome = "success", details = {}) {
  await tx.query(
    `INSERT INTO audit_events (workspace_id, actor_user_id, action, target_type, target_id, request_id, outcome, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [actor.workspaceId, actor.userId, action, target.type ?? null, target.id ?? null, actor.requestId ?? null, outcome, JSON.stringify(redact(details))]
  );
}
async function publishEvent(tx, e) {
  await tx.query(
    `INSERT INTO events (workspace_id, account_id, type, resource_id, revision, payload) VALUES ($1, $2, $3, $4, $5, $6)`,
    [e.workspaceId, e.accountId ?? null, e.type, e.resourceId ?? null, e.revision ?? null, JSON.stringify(e.payload ?? {})]
  );
}

// server/modules/imports/formats.ts
import { z as z2 } from "zod";

// server/modules/imports/parse/text.ts
import { parse as parseCsv } from "csv-parse/sync";
var ENCODINGS = ["utf-8", "windows-1252", "iso-8859-1"];
var DELIMITERS = [",", ";", "	", "|"];
var ParseError = class extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
  code;
};
function decode(bytes, encoding) {
  const enc = encoding ?? "utf-8";
  let text;
  try {
    text = new TextDecoder(enc, { fatal: true }).decode(bytes);
  } catch {
    throw new ParseError(
      "The file is not valid UTF-8. Choose the file encoding (for example Windows-1252) and try again.",
      "encoding_required"
    );
  }
  if (text.charCodeAt(0) === 65279) text = text.slice(1);
  if (text.includes("\0")) throw new ParseError("The file contains binary data and is not a text CSV/TSV file.", "binary_content");
  return { text, encoding: enc };
}
var MAX_ROWS = 2e5;
var MAX_COLUMNS = 200;
function parseRows(text, delimiter) {
  let rows;
  try {
    rows = parseCsv(text, {
      delimiter,
      relax_column_count: true,
      skip_empty_lines: false,
      bom: true,
      trim: false,
      max_record_size: 1e6
    });
  } catch (err) {
    throw new ParseError(`The file could not be parsed as delimited text: ${err.message}`, "malformed_csv");
  }
  if (rows.length > MAX_ROWS) throw new ParseError(`The file has more than ${MAX_ROWS.toLocaleString("en-US")} rows`, "too_many_rows");
  if (rows.some((r) => r.length > MAX_COLUMNS)) throw new ParseError(`A row has more than ${MAX_COLUMNS} columns`, "too_many_columns");
  return rows;
}
var normHeader = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
function inertText(s) {
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

// server/modules/imports/parse/values.ts
import Decimal from "decimal.js";

// shared/time/zoned.ts
var DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
function isIsoDate(s) {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}
function parts(date2) {
  const m = DATE_RE.exec(date2);
  if (!m || !isIsoDate(date2)) throw new Error(`Invalid calendar date: ${date2}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}
var fmt = (d) => d.toISOString().slice(0, 10);
function addDays(date2, n) {
  const [y, m, d] = parts(date2);
  return fmt(new Date(Date.UTC(y, m - 1, d + n)));
}
function diffDays(start, endExclusive) {
  const [y1, m1, d1] = parts(start);
  const [y2, m2, d2] = parts(endExclusive);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 864e5);
}
function addMonths(date2, n) {
  const [y, m, d] = parts(date2);
  const target = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return fmt(new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(d, last))));
}
var dtfCache = /* @__PURE__ */ new Map();
function dtf(tz) {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
    dtfCache.set(tz, f);
  }
  return f;
}
function zonedFields(instant, tz) {
  const out = {};
  for (const p of dtf(tz).formatToParts(instant)) if (p.type !== "literal") out[p.type] = Number(p.value);
  return out;
}
function localDate(instant, tz) {
  const f = zonedFields(instant, tz);
  return `${String(f.year).padStart(4, "0")}-${String(f.month).padStart(2, "0")}-${String(f.day).padStart(2, "0")}`;
}

// server/modules/imports/parse/values.ts
var ok = (value) => ({ ok: true, value });
var fail = (code, message) => ({ ok: false, code, message });
var CURRENCY_MARKS = /^(?:[A-Z]{3}\s*|[$€£¥₹]\s*|R\$\s*)|(?:\s*[A-Z]{3}|\s*[$€£¥₹])$/;
function parseDecimal(raw, fmt2, opts = {}) {
  let s = raw.trim();
  if (s === "") return ok(null);
  if (/^(n\/?a|null|none|-|—)$/i.test(s)) return ok(null);
  if (opts.allowPercentSign && s.endsWith("%")) s = s.slice(0, -1).trim();
  if (opts.allowCurrency) s = s.replace(CURRENCY_MARKS, "").trim();
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith("+")) s = s.slice(1);
  const { decimal, thousands } = fmt2;
  const esc = (c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const intPart = thousands ? `\\d{1,3}(?:${esc(thousands)}\\d{3})*|\\d+` : "\\d+";
  const re = new RegExp(`^(?:${intPart})(?:${esc(decimal)}\\d+)?$`);
  if (!re.test(s)) return fail("invalid_number", `"${raw}" is not a valid number in the chosen format (decimal "${decimal}", thousands "${thousands || "none"}")`);
  const normalized = (thousands ? s.split(thousands).join("") : s).replace(decimal, ".");
  const d = new Decimal(normalized);
  if (!d.isFinite()) return fail("invalid_number", `"${raw}" is not a finite number`);
  if (d.abs().gt("1e18")) return fail("number_out_of_range", `"${raw}" is too large`);
  return ok((negative ? d.neg() : d).toFixed());
}
function parseCount(raw, fmt2) {
  const r = parseDecimal(raw, fmt2);
  if (!r.ok || r.value === null) return r;
  const d = new Decimal(r.value);
  if (d.isNeg()) return fail("negative_count", `Counts cannot be negative ("${raw}")`);
  if (!d.isInteger()) return fail("fractional_count", `Counts must be whole numbers ("${raw}")`);
  return r;
}
function parseMoney(raw, fmt2) {
  const r = parseDecimal(raw, fmt2, { allowCurrency: true });
  if (!r.ok || r.value === null) return r;
  if (new Decimal(r.value).isNeg()) return fail("negative_amount", `Negative amounts are only valid in an adjustments format ("${raw}")`);
  if ((r.value.split(".")[1]?.length ?? 0) > 4) return fail("money_precision", `Amounts may have at most 4 decimal places ("${raw}")`);
  return r;
}
function parseRate(raw, fmt2, scale) {
  const hasSign = raw.trim().endsWith("%");
  const r = parseDecimal(raw, fmt2, { allowPercentSign: true });
  if (!r.ok || r.value === null) return r;
  let d = new Decimal(r.value);
  if (d.isNeg()) return fail("negative_rate", `Rates cannot be negative ("${raw}")`);
  if (scale === "fraction" && !hasSign) d = d.mul(100);
  return ok(d.toFixed());
}
var DATE_FORMATS = ["YYYY-MM-DD", "YYYY/MM/DD", "MM/DD/YYYY", "DD/MM/YYYY", "DD-MM-YYYY", "DD.MM.YYYY", "MM-DD-YYYY"];
function parseDate(raw, format) {
  const s = raw.trim();
  if (s === "") return ok(null);
  const iso = format === "YYYY-MM-DD" ? /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(s) : null;
  let y, m, d;
  if (iso) [, y, m, d] = iso;
  else {
    const sep = format.includes("/") ? "/" : format.includes(".") ? "." : "-";
    const parts2 = s.split(sep);
    const order = format.split(/[/.-]/);
    if (parts2.length !== 3 || parts2.some((p) => !/^\d+$/.test(p))) return fail("invalid_date", `"${raw}" does not match ${format}`);
    order.forEach((k, i) => {
      if (k === "YYYY") y = parts2[i];
      else if (k === "MM") m = parts2[i];
      else d = parts2[i];
    });
  }
  if (!y || y.length !== 4 || !m || !d || m.length > 2 || d.length > 2) return fail("invalid_date", `"${raw}" does not match ${format}`);
  const out = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  if (!isIsoDate(out)) return fail("invalid_date", `"${raw}" is not a real calendar date`);
  return ok(out);
}

// server/modules/imports/formats.ts
var CAMPAIGN_FIELDS = {
  campaignId: ["campaignid", "campaignexternalid", "externalcampaignid"],
  campaignName: ["campaignname", "name"],
  launchId: ["launchid", "launchexternalid"],
  channel: ["channel"],
  launchDate: ["launchdate", "senddate", "sentdate"],
  launchTime: ["launchtime", "sendtime", "senttime"],
  activityDate: ["activitydate", "eventdate", "reportdate"],
  program: ["program", "programname"],
  subjectLine: ["subjectline", "subject"],
  creativeType: ["creativetype", "contenttype", "creative", "creativeformat", "templatetype", "layout"],
  offer: ["offer", "offertype", "offername", "incentive", "promotion", "promotype", "discount"],
  currency: ["currency", "currencycode"],
  sent: ["sent", "totalsent"],
  delivered: ["delivered", "totaldelivered"],
  skipped: ["skipped"],
  bounces: ["bounces", "bounced", "totalbounces"],
  totalOpens: ["totalopens"],
  uniqueOpens: ["uniqueopens"],
  opensUnspecified: ["opens"],
  totalClicks: ["totalclicks"],
  uniqueClicks: ["uniqueclicks"],
  clicksUnspecified: ["clicks"],
  conversionEvents: ["conversions", "conversionevents"],
  orders: ["orders", "purchases"],
  revenue: ["revenue", "attributedrevenue"],
  unsubscribes: ["unsubscribes", "optouts"],
  complaints: ["complaints", "spamcomplaints"]
};
var WINDOW_LABELS = {
  today: { key: "today", kind: "today", n: 1 },
  yesterday: { key: "yesterday", kind: "yesterday", n: 1 },
  last7days: { key: "last_7_days", kind: "days", n: 7 },
  last14days: { key: "last_14_days", kind: "days", n: 14 },
  last30days: { key: "last_30_days", kind: "days", n: 30 },
  last60days: { key: "last_60_days", kind: "days", n: 60 },
  last90days: { key: "last_90_days", kind: "days", n: 90 },
  last180days: { key: "last_180_days", kind: "days", n: 180 },
  last365days: { key: "last_365_days", kind: "days", n: 365 },
  last3months: { key: "last_3_months", kind: "months", n: 3 },
  last6months: { key: "last_6_months", kind: "months", n: 6 },
  last12months: { key: "last_12_months", kind: "months", n: 12 },
  last2years: { key: "last_2_years", kind: "months", n: 24 }
};
function windowFor(label) {
  return WINDOW_LABELS[normHeader(label)] ?? null;
}
function normalizeChannel(raw) {
  const n = normHeader(raw);
  if (!n) return "";
  if (n === "email" || n === "mail") return "Email";
  if (n === "sms" || n === "smsblast" || n === "text") return "SMS";
  if (n === "mobileapp" || n === "mobileapps" || n === "push" || n === "pushnotification" || n === "apppush") return "Mobile App";
  if (n === "webpush") return "Web Push";
  return raw.trim().slice(0, 40);
}
var NumberFormatSchema = z2.object({
  decimal: z2.enum([".", ","]),
  thousands: z2.enum([",", ".", " ", ""])
}).refine((f) => f.decimal !== f.thousands, "Decimal and thousands separators must differ");
var Common = {
  encoding: z2.enum(ENCODINGS),
  delimiter: z2.enum(DELIMITERS),
  headerRowIndex: z2.number().int().min(0).max(14),
  columns: z2.record(z2.string(), z2.number().int().min(0).max(199).nullable()),
  numberFormat: NumberFormatSchema,
  currency: z2.string().regex(/^[A-Z]{3}$/),
  timezoneConfirmed: z2.literal(true, { error: "Confirm that the file uses the account timezone" }),
  datasetName: z2.string().trim().min(1).max(160),
  targetDatasetId: z2.string().uuid().nullable().default(null)
};
var LegacyMappingSchema = z2.object({
  format: z2.literal("legacy_summary"),
  ...Common,
  asOfDate: z2.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Export date must be YYYY-MM-DD"),
  windowEnd: z2.enum(["end_of_previous_day", "end_of_as_of_day"]),
  rateScale: z2.enum(["percent", "fraction"]),
  openRateMeaning: z2.enum(["unique", "total", "not_stated"]).optional(),
  clickRateMeaning: z2.enum(["unique", "total", "not_stated"]).optional(),
  conversionsMeaning: z2.enum(["events", "not_stated"]).optional(),
  defaultChannel: z2.string().trim().min(1).max(40).optional()
});
var CampaignMappingSchema = z2.object({
  format: z2.literal("campaign_metrics"),
  ...Common,
  dateFormat: z2.enum(DATE_FORMATS),
  opensMeaning: z2.enum(["total", "unique"]).optional(),
  clicksMeaning: z2.enum(["total", "unique"]).optional(),
  coverageStart: z2.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  coverageEnd: z2.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  defaultChannel: z2.string().trim().min(1).max(40).optional()
});
var MappingSchema = z2.discriminatedUnion("format", [LegacyMappingSchema, CampaignMappingSchema]);

// server/modules/imports/validate.ts
import { createHash as createHash2 } from "node:crypto";
import Decimal2 from "decimal.js";
var RATE_COLUMNS = ["bounceRate", "softBounceRate", "hardBounceRate", "openRate", "uniqueOpenRate", "totalOpenRate", "clickRate", "uniqueClickRate", "totalClickRate", "unsubscribeRate"];
var NUMERIC_LEGACY = ["sent", "delivered", "skipped", "revenue", "conversions", ...RATE_COLUMNS];
var isBlankRow = (r) => r.every((c) => c.trim() === "");
var MAX_REPORTED_ERRORS = 200;
var Collector = class {
  errors = [];
  count = 0;
  add(e) {
    this.count++;
    if (this.errors.length < MAX_REPORTED_ERRORS) this.errors.push({ ...e, value: e.value === null ? null : inertText(e.value.slice(0, 120)) });
  }
};
function cell(c, row, column, raw, fn) {
  if (raw === void 0) return null;
  const r = fn(raw);
  if (!r.ok) {
    c.add({ row, column, code: r.code, message: r.message, value: raw });
    return null;
  }
  return r.value;
}
function validate(bytes, mapping) {
  const { text } = decode(bytes, mapping.encoding);
  const rows = parseRows(text, mapping.delimiter);
  const header = rows[mapping.headerRowIndex];
  if (!header) throw new ParseError("The header row is missing", "missing_header");
  const dataStart = mapping.headerRowIndex + 1;
  const records = rows.slice(dataStart).map((r, i) => ({ r, line: dataStart + i + 1 })).filter(({ r }) => !isBlankRow(r));
  const colName = (f) => {
    const idx = mapping.columns[f];
    return idx === null || idx === void 0 ? f : header[idx]?.trim() || f;
  };
  return mapping.format === "legacy_summary" ? validateLegacy(records, mapping, colName, header.length) : validateCampaign(records, mapping, colName, header.length);
}
function getter(mapping) {
  return (r, field) => {
    const idx = mapping.columns[field];
    if (idx === null || idx === void 0) return void 0;
    return r[idx] ?? "";
  };
}
function signatureOf(obj) {
  return createHash2("sha256").update(JSON.stringify(obj)).digest("hex");
}
function validateLegacy(records, m, colName, width) {
  const c = new Collector();
  const get = getter(m);
  const warnings = [];
  const conflicts = [];
  if (!isIsoDate(m.asOfDate)) c.add({ row: 0, column: null, code: "invalid_as_of", message: "The export date is not a valid date", value: m.asOfDate });
  for (const f of ["range"]) {
    if (m.columns[f] === void 0 || m.columns[f] === null) c.add({ row: 0, column: f, code: "missing_required_column", message: `Required column "${f}" is not mapped`, value: null });
  }
  if ((m.columns.sent ?? null) === null && (m.columns.delivered ?? null) === null) {
    c.add({ row: 0, column: null, code: "missing_required_column", message: 'Map "Sent" or "Delivered"', value: null });
  }
  for (const [f, need] of [["openRate", m.openRateMeaning], ["clickRate", m.clickRateMeaning], ["conversions", m.conversionsMeaning]]) {
    if ((m.columns[f] ?? null) !== null && !need) c.add({ row: 0, column: f, code: "meaning_required", message: `Confirm what "${colName(f)}" measures`, value: null });
  }
  const end = m.windowEnd === "end_of_previous_day" ? m.asOfDate : addDays(m.asOfDate, 1);
  const facts = [];
  const seen = /* @__PURE__ */ new Set();
  const fmt2 = m.numberFormat;
  for (const { r, line } of records) {
    if (r.length !== width) {
      c.add({ row: line, column: null, code: "column_count", message: `Row has ${r.length} columns; the header has ${width}`, value: null });
      continue;
    }
    const label = (get(r, "range") ?? "").trim();
    if (!label) {
      c.add({ row: line, column: colName("range"), code: "missing_window", message: "The date range is empty", value: "" });
      continue;
    }
    if (/^(sent\s*date\s*range|channel)$/i.test(label)) {
      c.add({ row: line, column: colName("range"), code: "repeated_header", message: "A repeated header row was found inside the data", value: label });
      continue;
    }
    const w = windowFor(label);
    if (!w) {
      c.add({ row: line, column: colName("range"), code: "unknown_window", message: `"${label}" is not a supported date range label`, value: label });
      continue;
    }
    const channelRaw = get(r, "channel");
    const channel = normalizeChannel(channelRaw ?? m.defaultChannel ?? "");
    if (!channel) {
      c.add({ row: line, column: colName("channel"), code: "missing_channel", message: "The channel is empty", value: channelRaw ?? "" });
      continue;
    }
    let start;
    let endEx;
    if (w.kind === "today") {
      start = m.asOfDate;
      endEx = addDays(m.asOfDate, 1);
    } else if (w.kind === "yesterday") {
      start = addDays(m.asOfDate, -1);
      endEx = m.asOfDate;
    } else if (w.kind === "days") {
      start = addDays(end, -w.n);
      endEx = end;
    } else {
      start = addMonths(end, -w.n);
      endEx = end;
    }
    const key = `${channel}|${w.key}`;
    if (seen.has(key)) {
      c.add({ row: line, column: colName("range"), code: "duplicate_row", message: `${channel} / ${label} appears more than once`, value: label });
      continue;
    }
    seen.add(key);
    const before = c.count;
    const rate = (f) => cell(c, line, colName(f), get(r, f), (s) => parseRate(s, fmt2, m.rateScale));
    const fact = {
      channel,
      windowKey: w.key,
      windowLabel: label,
      windowDays: diffDays(start, endEx),
      windowStart: start,
      windowEndExclusive: endEx,
      sent: cell(c, line, colName("sent"), get(r, "sent"), (s) => parseCount(s, fmt2)),
      delivered: cell(c, line, colName("delivered"), get(r, "delivered"), (s) => parseCount(s, fmt2)),
      skipped: cell(c, line, colName("skipped"), get(r, "skipped"), (s) => parseCount(s, fmt2)),
      bounceRate: rate("bounceRate"),
      softBounceRate: rate("softBounceRate"),
      hardBounceRate: rate("hardBounceRate"),
      openRate: rate("uniqueOpenRate") ?? rate("totalOpenRate") ?? rate("openRate"),
      clickRate: rate("uniqueClickRate") ?? rate("totalClickRate") ?? rate("clickRate"),
      unsubscribeRate: rate("unsubscribeRate"),
      revenue: cell(c, line, colName("revenue"), get(r, "revenue"), (s) => parseMoney(s, fmt2)),
      conversions: cell(c, line, colName("conversions"), get(r, "conversions"), (s) => parseCount(s, fmt2)),
      sourceRow: line
    };
    if (c.count > before) continue;
    if (fact.sent !== null && fact.delivered !== null && new Decimal2(fact.delivered).gt(fact.sent)) {
      c.add({ row: line, column: colName("delivered"), code: "delivered_exceeds_sent", message: "Delivered is greater than Sent", value: fact.delivered });
      continue;
    }
    if (channel !== "Email" && (fact.openRate !== null || fact.bounceRate !== null)) {
      warnings.push(`Row ${line}: ${channel} has email-style open/bounce rates; they are kept as reported and not interpreted as email metrics.`);
    }
    facts.push(fact);
  }
  if (!records.length) c.add({ row: 0, column: null, code: "no_data_rows", message: "No data rows were found under the header", value: null });
  const byChannel = /* @__PURE__ */ new Map();
  for (const f of facts) byChannel.set(f.channel, [...byChannel.get(f.channel) ?? [], f]);
  for (const [ch, list] of byChannel) {
    const nested = list.filter((f) => f.windowEndExclusive === end).sort((a, b) => a.windowDays - b.windowDays);
    for (let i = 1; i < nested.length; i++) {
      const shorter = nested[i - 1];
      const longer = nested[i];
      for (const k of ["sent", "delivered", "skipped", "revenue", "conversions"]) {
        const a = shorter[k];
        const b = longer[k];
        if (a !== null && b !== null && new Decimal2(b).lt(a)) {
          conflicts.push(`${ch}: ${k} for "${longer.windowLabel}" (${b}) is smaller than for "${shorter.windowLabel}" (${a}); the source windows are inconsistent`);
        }
      }
    }
  }
  const semantics = {
    open_rate: m.columns.uniqueOpenRate != null ? "unique" : m.columns.totalOpenRate != null ? "total" : m.openRateMeaning ?? "absent",
    click_rate: m.columns.uniqueClickRate != null ? "unique" : m.columns.totalClickRate != null ? "total" : m.clickRateMeaning ?? "absent",
    conversions: m.columns.conversions != null ? m.conversionsMeaning ?? "not_stated" : "absent",
    rate_scale: m.rateScale,
    window_end: m.windowEnd
  };
  const coverage = facts.length ? { start: facts.map((f) => f.windowStart).sort()[0], endExclusive: facts.map((f) => f.windowEndExclusive).sort().at(-1) } : null;
  const limitations = [
    "Account-period totals only: no campaign, launch, recipient, segment, link, domain, or hourly detail.",
    "Rates are kept as reported; their numerators are not in the file, so counts are not reconstructed.",
    "Windows are alternate views of overlapping activity and are never added together.",
    "Only the date ranges present in the file can be shown; arbitrary custom ranges are not available."
  ];
  const ok2 = c.count === 0;
  return {
    result: {
      format: "legacy_summary",
      ok: ok2,
      rowCount: records.length,
      acceptedRows: ok2 ? facts.length : 0,
      errorCount: c.count,
      errors: c.errors,
      warnings: [...new Set(warnings)].slice(0, 50),
      conflicts,
      limitations,
      coverage,
      channels: [...byChannel.keys()].sort(),
      campaignCount: null,
      windows: [...new Set(facts.map((f) => f.windowLabel))],
      grain: "account_window",
      timeBasis: "declared_snapshot",
      semantics,
      sourceAsOf: m.asOfDate,
      signature: signatureOf({ format: "legacy_summary", end, currency: m.currency, semantics, facts: facts.map(({ sourceRow: _s, ...f }) => f) }),
      preview: facts.slice(0, 12).map((f) => ({ ...f }))
    },
    legacyFacts: ok2 ? facts : [],
    campaignFacts: []
  };
}
function validateCampaign(records, m, colName, width) {
  const c = new Collector();
  const get = getter(m);
  const warnings = [];
  const fmt2 = m.numberFormat;
  if ((m.columns.campaignId ?? null) === null) c.add({ row: 0, column: "campaignId", code: "missing_required_column", message: "Map the Campaign ID column", value: null });
  if ((m.columns.launchDate ?? null) === null) c.add({ row: 0, column: "launchDate", code: "missing_required_column", message: "Map the Launch Date column", value: null });
  if ((m.columns.sent ?? null) === null && (m.columns.delivered ?? null) === null) {
    c.add({ row: 0, column: null, code: "missing_required_column", message: 'Map "Sent" or "Delivered"', value: null });
  }
  if ((m.columns.opensUnspecified ?? null) !== null && !m.opensMeaning) c.add({ row: 0, column: "opens", code: "meaning_required", message: 'Confirm whether "Opens" are total or unique opens', value: null });
  if ((m.columns.clicksUnspecified ?? null) !== null && !m.clicksMeaning) c.add({ row: 0, column: "clicks", code: "meaning_required", message: 'Confirm whether "Clicks" are total or unique clicks', value: null });
  for (const f of Object.keys(m.columns)) {
    if (!(f in CAMPAIGN_FIELDS)) c.add({ row: 0, column: f, code: "unknown_field", message: `Unknown field "${f}"`, value: null });
  }
  const daily = (m.columns.activityDate ?? null) !== null;
  const facts = [];
  const seen = /* @__PURE__ */ new Set();
  const names = /* @__PURE__ */ new Map();
  const date2 = (f, r, line) => cell(c, line, colName(f), get(r, f), (s) => parseDate(s, m.dateFormat));
  const count = (f, r, line) => cell(c, line, colName(f), get(r, f), (s) => parseCount(s, fmt2));
  for (const { r, line } of records) {
    if (r.length !== width) {
      c.add({ row: line, column: null, code: "column_count", message: `Row has ${r.length} columns; the header has ${width}`, value: null });
      continue;
    }
    const before = c.count;
    const campaignExternalId = (get(r, "campaignId") ?? "").trim();
    if (!campaignExternalId) c.add({ row: line, column: colName("campaignId"), code: "missing_campaign_id", message: "Campaign ID is empty", value: "" });
    else if (campaignExternalId.length > 200) c.add({ row: line, column: colName("campaignId"), code: "campaign_id_too_long", message: "Campaign ID is longer than 200 characters", value: campaignExternalId });
    const channel = normalizeChannel(get(r, "channel") ?? m.defaultChannel ?? "");
    if (!channel) c.add({ row: line, column: colName("channel"), code: "missing_channel", message: "The channel is empty", value: "" });
    const launchDate = date2("launchDate", r, line);
    if ((m.columns.launchDate ?? null) !== null && launchDate === null && c.count === before) {
      c.add({ row: line, column: colName("launchDate"), code: "missing_launch_date", message: "Launch date is empty", value: "" });
    }
    const factDate = daily ? date2("activityDate", r, line) : null;
    if (daily && factDate === null && c.count === before) c.add({ row: line, column: colName("activityDate"), code: "missing_activity_date", message: "Activity date is empty", value: "" });
    if (launchDate && factDate && factDate < launchDate) {
      c.add({ row: line, column: colName("activityDate"), code: "activity_before_launch", message: "Activity date is before the launch date", value: factDate });
    }
    const rowCurrency = (get(r, "currency") ?? "").trim().toUpperCase();
    if (rowCurrency && rowCurrency !== m.currency) {
      c.add({ row: line, column: colName("currency"), code: "currency_mismatch", message: `Row currency ${rowCurrency} differs from the dataset currency ${m.currency}; mixed currencies must be imported as separate datasets`, value: rowCurrency });
    }
    const opens = count("opensUnspecified", r, line);
    const clicks = count("clicksUnspecified", r, line);
    const launchTime = (get(r, "launchTime") ?? "").trim();
    if (launchTime && !/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(launchTime)) c.add({ row: line, column: colName("launchTime"), code: "invalid_launch_time", message: "Launch Time must be HH:mm or HH:mm:ss in the account timezone", value: launchTime });
    const fact = {
      campaignExternalId,
      campaignName: (get(r, "campaignName") ?? "").trim().slice(0, 300) || campaignExternalId,
      launchExternalId: (get(r, "launchId") ?? "").trim().slice(0, 200) || null,
      channel,
      launchDate: launchDate ?? "",
      launchTime: launchTime || null,
      factDate,
      program: (get(r, "program") ?? "").trim().slice(0, 300) || null,
      subjectLine: (get(r, "subjectLine") ?? "").trim().slice(0, 500) || null,
      creativeType: (get(r, "creativeType") ?? "").trim().slice(0, 200) || null,
      offer: (get(r, "offer") ?? "").trim().slice(0, 200) || null,
      sent: count("sent", r, line),
      delivered: count("delivered", r, line),
      skipped: count("skipped", r, line),
      bounces: count("bounces", r, line),
      totalOpens: count("totalOpens", r, line) ?? (m.opensMeaning === "total" ? opens : null),
      uniqueOpens: count("uniqueOpens", r, line) ?? (m.opensMeaning === "unique" ? opens : null),
      totalClicks: count("totalClicks", r, line) ?? (m.clicksMeaning === "total" ? clicks : null),
      uniqueClicks: count("uniqueClicks", r, line) ?? (m.clicksMeaning === "unique" ? clicks : null),
      conversionEvents: count("conversionEvents", r, line),
      orders: count("orders", r, line),
      revenue: cell(c, line, colName("revenue"), get(r, "revenue"), (s) => parseMoney(s, fmt2)),
      unsubscribes: count("unsubscribes", r, line),
      complaints: count("complaints", r, line),
      sourceRow: line
    };
    if (c.count > before) continue;
    if (fact.sent !== null && fact.delivered !== null && new Decimal2(fact.delivered).gt(fact.sent)) {
      c.add({ row: line, column: colName("delivered"), code: "delivered_exceeds_sent", message: "Delivered is greater than Sent", value: fact.delivered });
      continue;
    }
    if (fact.uniqueOpens !== null && fact.totalOpens !== null && new Decimal2(fact.uniqueOpens).gt(fact.totalOpens)) {
      c.add({ row: line, column: colName("uniqueOpens"), code: "unique_exceeds_total", message: "Unique opens exceed total opens", value: fact.uniqueOpens });
      continue;
    }
    if (fact.uniqueClicks !== null && fact.totalClicks !== null && new Decimal2(fact.uniqueClicks).gt(fact.totalClicks)) {
      c.add({ row: line, column: colName("uniqueClicks"), code: "unique_exceeds_total", message: "Unique clicks exceed total clicks", value: fact.uniqueClicks });
      continue;
    }
    const key = `${campaignExternalId}|${fact.launchExternalId ?? ""}|${fact.launchDate}|${fact.factDate ?? ""}`;
    if (seen.has(key)) {
      c.add({ row: line, column: null, code: "duplicate_row", message: "This campaign/launch/date combination appears more than once", value: campaignExternalId });
      continue;
    }
    seen.add(key);
    const prevName = names.get(campaignExternalId);
    if (prevName && prevName !== fact.campaignName) warnings.push(`Campaign ${campaignExternalId} has more than one name in the file; the latest launch's name is shown.`);
    names.set(campaignExternalId, fact.campaignName);
    if (channel !== "Email" && (fact.totalOpens !== null || fact.uniqueOpens !== null)) {
      warnings.push(`Row ${line}: ${channel} rows include open counts; they are kept as reported.`);
    }
    facts.push(fact);
  }
  if (!records.length) c.add({ row: 0, column: null, code: "no_data_rows", message: "No data rows were found under the header", value: null });
  const periodDates = facts.map((f) => daily ? f.factDate : f.launchDate).filter(Boolean).sort();
  let coverage = null;
  const start = m.coverageStart ?? periodDates[0];
  const endInc = m.coverageEnd ?? periodDates.at(-1);
  if (start && endInc) {
    if (!isIsoDate(start) || !isIsoDate(endInc) || endInc < start) {
      c.add({ row: 0, column: null, code: "invalid_coverage", message: "The coverage dates are not valid", value: `${start}..${endInc}` });
    } else {
      coverage = { start, endExclusive: addDays(endInc, 1) };
      const outside = periodDates.filter((d) => d < start || d > endInc);
      if (outside.length) {
        c.add({ row: 0, column: null, code: "rows_outside_coverage", message: `${outside.length} row(s) fall outside the declared coverage ${start} \u2013 ${endInc}`, value: null });
      }
    }
  }
  const has = (k) => facts.some((f) => f[k] !== null);
  const limitations = [];
  if (!has("uniqueOpens") && !has("totalOpens")) limitations.push("No open counts: open rates are unavailable.");
  if (!has("uniqueClicks") && !has("totalClicks")) limitations.push("No click counts: click rates are unavailable.");
  if (!has("orders")) limitations.push("No orders field: average order value is unavailable (conversion events are not orders).");
  if (daily) limitations.push("Daily rows: unique opens/clicks cannot be summed across days of the same launch.");
  limitations.push("No recipient, segment, link, or domain detail is included in this file.");
  if (!has("launchTime")) limitations.push("No launch clock times: hourly send-time estimates are unavailable.");
  limitations.push("Revenue is provider-attributed as reported, not incremental or reconciled revenue.");
  const ok2 = c.count === 0;
  const semantics = {
    opens: m.columns.opensUnspecified != null ? m.opensMeaning ?? "unconfirmed" : "explicit",
    clicks: m.columns.clicksUnspecified != null ? m.clicksMeaning ?? "unconfirmed" : "explicit",
    unique_clicks: "source-defined (may count distinct links per recipient)"
  };
  return {
    result: {
      format: "campaign_metrics",
      ok: ok2,
      rowCount: records.length,
      acceptedRows: ok2 ? facts.length : 0,
      errorCount: c.count,
      errors: c.errors,
      warnings: [...new Set(warnings)].slice(0, 50),
      conflicts: [],
      limitations,
      coverage,
      channels: [...new Set(facts.map((f) => f.channel))].sort(),
      campaignCount: names.size,
      windows: null,
      grain: daily ? "campaign_day" : "campaign_launch",
      timeBasis: daily ? "event_time" : "send_cohort",
      semantics,
      sourceAsOf: null,
      signature: signatureOf({ format: "campaign_metrics", currency: m.currency, coverage, semantics, facts: facts.map(({ sourceRow: _s, ...f }) => f) }),
      preview: facts.slice(0, 12).map((f) => ({ ...f }))
    },
    legacyFacts: [],
    campaignFacts: ok2 ? facts : []
  };
}

// server/modules/datasets/service.ts
async function bumpRevision(tx, accountId) {
  const { rows } = await tx.query("UPDATE accounts SET data_revision = data_revision + 1 WHERE id = $1 RETURNING data_revision", [accountId]);
  return rows[0].data_revision;
}
async function activateVersion(tx, actor, datasetId, versionId, reason) {
  const ds = await tx.query("SELECT account_id FROM datasets WHERE id = $1 FOR UPDATE", [datasetId]);
  if (!ds.rows[0]) throw notFound("Dataset");
  const v = await tx.query("SELECT status FROM dataset_versions WHERE id = $1 AND dataset_id = $2", [versionId, datasetId]);
  if (!v.rows[0]) throw notFound("Dataset version");
  if (v.rows[0].status === "failed") throw new AppError("conflict", "A failed version cannot be activated");
  await tx.query(`UPDATE dataset_versions SET status = 'superseded', superseded_at = now() WHERE dataset_id = $1 AND status = 'active' AND id <> $2`, [datasetId, versionId]);
  await tx.query(`UPDATE dataset_versions SET status = 'active', activated_at = now(), superseded_at = NULL WHERE id = $1`, [versionId]);
  await tx.query("UPDATE datasets SET active_version_id = $2, archived_at = NULL WHERE id = $1", [datasetId, versionId]);
  const revision = await bumpRevision(tx, ds.rows[0].account_id);
  await audit(tx, actor, `dataset.activate`, { type: "dataset_version", id: versionId }, "success", { datasetId, reason, revision });
  await publishEvent(tx, { workspaceId: actor.workspaceId, accountId: ds.rows[0].account_id, type: "dataset.activated", resourceId: datasetId, revision, payload: { datasetVersionId: versionId, reason } });
  return revision;
}

// server/modules/imports/service.ts
async function checkTargetDataset(tx, accountId, mapping) {
  if (!mapping.targetDatasetId) return;
  const { rows } = await tx.query("SELECT source_type, account_id FROM datasets WHERE id = $1", [mapping.targetDatasetId]);
  const ds = rows[0];
  if (!ds || ds.account_id !== accountId) throw new AppError("unprocessable", "The dataset to replace was not found in this account");
  const expected = mapping.format === "legacy_summary" ? "upload_legacy_summary" : "upload_campaign_metrics";
  if (ds.source_type !== expected) throw new AppError("unprocessable", "The dataset to replace holds a different kind of data");
}
var BATCH = 500;
async function insertBatched(tx, table, columns, rows) {
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const values = [];
    const tuples = chunk.map((r) => {
      const ph = r.map((v) => {
        values.push(v);
        return `$${values.length}`;
      });
      return `(${ph.join(", ")})`;
    });
    await tx.query(`INSERT INTO ${table} (${columns.join(", ")}) VALUES ${tuples.join(", ")}`, values);
  }
}
function importCommitHandler(storage) {
  return async (job, { db, heartbeat }) => {
    const importId = String(job.payload.importId ?? "");
    const t = { workspaceId: job.workspace_id, userId: job.created_by ?? "" };
    const imp = await db.withTenant(t, async (tx) => {
      const { rows } = await tx.query(
        `SELECT i.status, i.account_id, i.mapping, r.storage_key, r.original_filename, i.dataset_version_id, i.created_by
           FROM import_jobs i JOIN raw_objects r ON r.id = i.raw_object_id WHERE i.id = $1`,
        [importId]
      );
      return rows[0];
    });
    if (!imp) throw new PermanentJobError("Import not found");
    if (imp.status === "completed") return { alreadyCompleted: true };
    if (imp.status !== "committing") throw new PermanentJobError(`Import is ${imp.status}`);
    const actor = { workspaceId: job.workspace_id, userId: imp.created_by };
    const fail2 = async (message) => {
      await db.withTenant(t, async (tx) => {
        await tx.query(`UPDATE import_jobs SET status = 'failed', error_message = $2, updated_at = now() WHERE id = $1`, [importId, message]);
        await audit(tx, actor, "import.commit", { type: "import", id: importId }, "failure", { message });
        await publishEvent(tx, { workspaceId: t.workspaceId, accountId: imp.account_id, type: "import.progress", resourceId: importId, payload: { status: "failed", message } });
      });
      throw new PermanentJobError(message);
    };
    const mapping = MappingSchema.safeParse(imp.mapping);
    if (!mapping.success) return fail2("The stored mapping is no longer valid");
    const bytes = await storage.get(imp.storage_key);
    const out = validate(bytes, mapping.data);
    if (!out.result.ok) return fail2(`Validation failed with ${out.result.errorCount} error(s)`);
    await heartbeat();
    const r = out.result;
    const m = mapping.data;
    const sourceType = m.format === "legacy_summary" ? "upload_legacy_summary" : "upload_campaign_metrics";
    const staged = await db.withTenant(t, async (tx) => {
      const acct = await tx.query("SELECT timezone FROM accounts WHERE id = $1", [imp.account_id]);
      let datasetId = m.targetDatasetId;
      if (datasetId) {
        await checkTargetDataset(tx, imp.account_id, m);
        await tx.query("SELECT id FROM datasets WHERE id = $1 FOR UPDATE", [datasetId]);
        const active = await tx.query(`SELECT id, content_signature FROM dataset_versions WHERE dataset_id = $1 AND status = 'active'`, [datasetId]);
        if (active.rows[0]?.content_signature === r.signature) return { unchanged: true, versionId: active.rows[0].id, datasetId };
      } else {
        const existing = await tx.query("SELECT dataset_id FROM dataset_versions WHERE import_job_id = $1 LIMIT 1", [importId]);
        datasetId = existing.rows[0]?.dataset_id ?? null;
        if (!datasetId) {
          const ds = await tx.query(
            `INSERT INTO datasets (workspace_id, account_id, name, source_type, grain, time_basis, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [t.workspaceId, imp.account_id, m.datasetName, sourceType, r.grain, r.timeBasis, imp.created_by]
          );
          datasetId = ds.rows[0].id;
        }
      }
      await tx.query(`DELETE FROM dataset_versions WHERE import_job_id = $1 AND status = 'staged'`, [importId]);
      const next = await tx.query("SELECT COALESCE(MAX(version), 0) + 1 AS v FROM dataset_versions WHERE dataset_id = $1", [datasetId]);
      const ver = await tx.query(
        `INSERT INTO dataset_versions (workspace_id, dataset_id, account_id, version, status, import_job_id, timezone, currency, source_as_of,
                                       coverage_start, coverage_end_exclusive, row_count, quality, content_signature, created_by)
         VALUES ($1, $2, $3, $4, 'staged', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
        [
          t.workspaceId,
          datasetId,
          imp.account_id,
          next.rows[0].v,
          importId,
          acct.rows[0].timezone,
          m.currency,
          r.sourceAsOf ? `${r.sourceAsOf}T00:00:00Z` : null,
          r.coverage?.start ?? null,
          r.coverage?.endExclusive ?? null,
          r.acceptedRows,
          JSON.stringify({ warnings: r.warnings, conflicts: r.conflicts, limitations: r.limitations, semantics: r.semantics, grain: r.grain }),
          r.signature,
          imp.created_by
        ]
      );
      const versionId = ver.rows[0].id;
      if (m.format === "legacy_summary") await insertLegacy(tx, t.workspaceId, imp.account_id, versionId, m.currency, out.legacyFacts);
      else await insertCampaign(tx, t.workspaceId, imp.account_id, versionId, m.currency, out.campaignFacts);
      await tx.query(`UPDATE import_jobs SET dataset_version_id = $2, target_dataset_id = $3, updated_at = now() WHERE id = $1`, [importId, versionId, datasetId]);
      return { unchanged: false, versionId, datasetId };
    });
    await heartbeat();
    return db.withTenant(t, async (tx) => {
      const cur = await tx.query("SELECT status FROM import_jobs WHERE id = $1 FOR UPDATE", [importId]);
      if (cur.rows[0]?.status === "completed") return { alreadyCompleted: true };
      if (staged.unchanged) {
        const prev = await tx.query("SELECT id FROM import_jobs WHERE dataset_version_id = $1 AND id <> $2 LIMIT 1", [staged.versionId, importId]);
        await tx.query(
          `UPDATE import_jobs SET status = 'completed', completed_at = now(), updated_at = now(), duplicate_of = $2,
                  error_message = 'The data is identical to the active version; no new version was created' WHERE id = $1`,
          [importId, prev.rows[0]?.id ?? null]
        );
        await audit(tx, actor, "import.commit", { type: "import", id: importId }, "success", { unchanged: true });
        await publishEvent(tx, { workspaceId: t.workspaceId, accountId: imp.account_id, type: "import.progress", resourceId: importId, payload: { status: "completed", unchanged: true } });
        return { unchanged: true, datasetVersionId: staged.versionId };
      }
      const revision = await activateVersion(tx, actor, staged.datasetId, staged.versionId, "import");
      await tx.query(`UPDATE import_jobs SET status = 'completed', completed_at = now(), updated_at = now(), error_message = NULL WHERE id = $1`, [importId]);
      await audit(tx, actor, "import.commit", { type: "import", id: importId }, "success", { datasetId: staged.datasetId, datasetVersionId: staged.versionId, rows: r.acceptedRows, revision });
      await publishEvent(tx, { workspaceId: t.workspaceId, accountId: imp.account_id, type: "import.progress", resourceId: importId, revision, payload: { status: "completed", datasetId: staged.datasetId } });
      return { datasetId: staged.datasetId, datasetVersionId: staged.versionId, revision };
    });
  };
}
async function insertLegacy(tx, ws, accountId, versionId, currency, facts) {
  await insertBatched(
    tx,
    "summary_window_facts",
    [
      "workspace_id",
      "account_id",
      "dataset_version_id",
      "channel",
      "window_key",
      "window_label",
      "window_days",
      "window_start",
      "window_end_exclusive",
      "currency",
      "sent",
      "delivered",
      "skipped",
      "bounce_rate",
      "soft_bounce_rate",
      "hard_bounce_rate",
      "open_rate",
      "click_rate",
      "unsubscribe_rate",
      "revenue",
      "conversions",
      "source_row"
    ],
    facts.map((f) => [
      ws,
      accountId,
      versionId,
      f.channel,
      f.windowKey,
      f.windowLabel,
      f.windowDays,
      f.windowStart,
      f.windowEndExclusive,
      currency,
      f.sent,
      f.delivered,
      f.skipped,
      f.bounceRate,
      f.softBounceRate,
      f.hardBounceRate,
      f.openRate,
      f.clickRate,
      f.unsubscribeRate,
      f.revenue,
      f.conversions,
      f.sourceRow
    ])
  );
}
async function insertCampaign(tx, ws, accountId, versionId, currency, facts) {
  const latest = /* @__PURE__ */ new Map();
  for (const f of facts) {
    const cur = latest.get(f.campaignExternalId);
    if (!cur || f.launchDate >= cur.launchDate) latest.set(f.campaignExternalId, f);
  }
  const ids = /* @__PURE__ */ new Map();
  const list = [...latest.values()];
  for (let i = 0; i < list.length; i += BATCH) {
    const chunk = list.slice(i, i + BATCH);
    const values = [];
    const tuples = chunk.map((f) => {
      values.push(ws, accountId, f.campaignExternalId, f.campaignName, f.channel, f.program);
      const n = values.length;
      return `($${n - 5}, $${n - 4}, $${n - 3}, $${n - 2}, $${n - 1}, $${n})`;
    });
    const { rows } = await tx.query(
      `INSERT INTO campaigns (workspace_id, account_id, external_id, name, channel, program) VALUES ${tuples.join(", ")}
       ON CONFLICT (workspace_id, account_id, external_id) DO UPDATE SET updated_at = now() RETURNING id, external_id`,
      values
    );
    for (const r of rows) ids.set(r.external_id, r.id);
  }
  await insertBatched(
    tx,
    "campaign_launch_facts",
    [
      "workspace_id",
      "account_id",
      "dataset_version_id",
      "campaign_id",
      "launch_external_id",
      "channel",
      "launch_date",
      "launch_time",
      "fact_date",
      "campaign_name",
      "program",
      "subject_line",
      "creative_type",
      "offer",
      "currency",
      "sent",
      "delivered",
      "skipped",
      "bounces",
      "total_opens",
      "unique_opens",
      "total_clicks",
      "unique_clicks",
      "conversion_events",
      "orders",
      "revenue",
      "unsubscribes",
      "complaints",
      "source_row"
    ],
    facts.map((f) => [
      ws,
      accountId,
      versionId,
      ids.get(f.campaignExternalId),
      f.launchExternalId,
      f.channel,
      f.launchDate,
      f.launchTime ?? null,
      f.factDate,
      f.campaignName,
      f.program,
      f.subjectLine,
      f.creativeType,
      f.offer,
      currency,
      f.sent,
      f.delivered,
      f.skipped,
      f.bounces,
      f.totalOpens,
      f.uniqueOpens,
      f.totalClicks,
      f.uniqueClicks,
      f.conversionEvents,
      f.orders,
      f.revenue,
      f.unsubscribes,
      f.complaints,
      f.sourceRow
    ])
  );
}

// server/jobs/handlers.ts
function buildHandlers(deps) {
  return {
    "import.commit": importCommitHandler(deps.storage),
    ...deps.extra ?? {}
  };
}

// server/integrations/responsys/client.ts
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
var ResponsysError = class extends Error {
  constructor(message, kind, status, retryAfterSec) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.retryAfterSec = retryAfterSec;
  }
  kind;
  status;
  retryAfterSec;
  get retryable() {
    return ["rate_limited", "server", "timeout", "network"].includes(this.kind);
  }
};
var REPORTING_ROW_CEILING = 1e4;
var REPORTING_MAX_SPAN_DAYS = 30;
var TOKEN_TTL_MS = 2 * 36e5;
var REFRESH_MARGIN_MS = 15 * 6e4;
function validateEndpoint(raw, suffixes, allowInsecureLocalhost = false) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new ResponsysError("The Responsys endpoint is not a valid URL", "unsafe_endpoint");
  }
  const local = allowInsecureLocalhost && (u.hostname === "127.0.0.1" || u.hostname === "localhost");
  if (u.username || u.password) throw new ResponsysError("Endpoint URLs must not contain credentials", "unsafe_endpoint");
  if (local) return u;
  if (u.protocol !== "https:") throw new ResponsysError("Responsys endpoints must use HTTPS", "unsafe_endpoint");
  const host = u.hostname.toLowerCase();
  if (!suffixes.some((s) => host === s.replace(/^\./, "") || host.endsWith(s.startsWith(".") ? s : `.${s}`))) {
    throw new ResponsysError(`Host ${host} is not on the approved Responsys host list`, "unsafe_endpoint");
  }
  return u;
}
function toConnectDate(iso) {
  const [y, m, d] = iso.split("-");
  return `${m}-${d}-${y}`;
}
var ResponsysClient = class {
  constructor(opts) {
    this.opts = opts;
    validateEndpoint(opts.loginBaseUrl, opts.allowedHostSuffixes, opts.allowInsecureLocalhost);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }
  opts;
  token = null;
  endpoint = null;
  issuedAtMs = 0;
  fetchImpl;
  now;
  get serviceEndpoint() {
    return this.endpoint?.origin ?? null;
  }
  async send(url, init) {
    try {
      return await this.fetchImpl(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(this.opts.timeoutMs ?? 3e4) });
    } catch (e) {
      const err = e;
      if (err.name === "TimeoutError" || err.name === "AbortError") throw new ResponsysError("Responsys did not respond in time", "timeout");
      const code = err.cause?.code && /^[A-Z0-9_]{1,60}$/.test(err.cause.code) ? err.cause.code : "NETWORK_ERROR";
      const reason = code === "UND_ERR_CONNECT_TIMEOUT" || code === "ETIMEDOUT" ? "Connection to the Responsys HTTPS endpoint timed out before authentication. Verify the WS End Point, VPN/proxy and outbound port 443." : code === "ENOTFOUND" || code === "EAI_AGAIN" ? "The Responsys hostname could not be resolved. Verify the WS End Point and DNS connection." : /CERT|TLS|SSL/.test(code) ? "TLS certificate validation failed. Check the server trust store or corporate proxy certificate with your IT administrator." : code === "ECONNREFUSED" ? "The Responsys endpoint refused the HTTPS connection. Verify the hostname and network access." : "The server could not establish an HTTPS connection to Responsys. Check the endpoint and network access.";
      throw new ResponsysError(`${code}: ${reason}`, "network");
    }
  }
  async authenticate() {
    const login = validateEndpoint(this.opts.loginBaseUrl, this.opts.allowedHostSuffixes, this.opts.allowInsecureLocalhost);
    const body = new URLSearchParams({ user_name: this.opts.credentials.username, password: this.opts.credentials.password, auth_type: "password" });
    const res = await this.send(new URL("/rest/api/v1.3/auth/token", login), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body
    });
    if (res.status === 401 || res.status === 400 || res.status === 403) throw new ResponsysError("Responsys rejected the API credentials", "auth", res.status);
    if (!res.ok) throw await classify(res);
    const json = await res.json().catch(() => null);
    if (!json || typeof json.authToken !== "string" || typeof json.endPoint !== "string") {
      throw new ResponsysError("Unexpected authentication response (no authToken/endPoint)", "invalid_response");
    }
    this.endpoint = validateEndpoint(json.endPoint, this.opts.allowedHostSuffixes, this.opts.allowInsecureLocalhost);
    this.token = json.authToken;
    this.issuedAtMs = typeof json.issuedAt === "number" ? json.issuedAt : this.now();
  }
  tokenFresh() {
    return this.token && this.now() - this.issuedAtMs < TOKEN_TTL_MS - REFRESH_MARGIN_MS;
  }
  async request(method, path2, opts = {}, retried = false) {
    if (!this.tokenFresh()) await this.authenticate();
    const url = new URL(path2, this.endpoint);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    const res = await this.send(url, {
      method,
      headers: { Authorization: this.token, "Content-Type": "application/json", Accept: "application/json" },
      body: opts.json === void 0 ? void 0 : JSON.stringify(opts.json)
    });
    if (res.status === 401 && !retried) {
      const failure = await classify(res.clone());
      if (failure.kind === "permission") throw failure;
      this.token = null;
      return this.request(method, path2, opts, true);
    }
    if (!res.ok && res.status !== 202) throw await classify(res);
    return res;
  }
  async json(res) {
    const bytes = await readBounded(res, this.opts.maxResponseBytes ?? 20 * 1024 * 1024);
    try {
      return JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new ResponsysError("Responsys returned a response that is not JSON", "invalid_response", res.status);
    }
  }
  async getRateLimits() {
    return this.json(await this.request("GET", "/rest/api/ratelimit"));
  }
  async listCampaigns(limit = 200, offset = 0) {
    const body = await this.json(await this.request("GET", "/rest/api/v1.3/campaigns", { query: { limit: String(limit), offset: String(offset) } }));
    const list = body.campaigns ?? body.items ?? [];
    if (!Array.isArray(list)) throw new ResponsysError("Unexpected campaigns response", "invalid_response");
    return list;
  }
  async listConnectJobs() {
    const body = await this.json(await this.request("GET", "/rest/api/v1.3/connectJobs"));
    const list = Array.isArray(body) ? body : body?.connectJobs ?? body?.jobs;
    if (!Array.isArray(list)) throw new ResponsysError("Unexpected Connect jobs response", "invalid_response");
    return list;
  }
  async listJobRuns(jobId, fromIso, toIso) {
    const body = await this.json(
      await this.request("GET", `/rest/api/v1.3/connectJobs/${encodeURIComponent(jobId)}/jobRuns`, { query: { sdate: toConnectDate(fromIso), edate: toConnectDate(toIso) } })
    );
    const list = Array.isArray(body) ? body : body?.jobRuns ?? body?.runs;
    if (!Array.isArray(list)) throw new ResponsysError("Unexpected Connect job runs response", "invalid_response");
    return list;
  }
  async getJobRunStatus(jobId, runId) {
    return this.json(await this.request("GET", `/rest/api/v1.3/connectJobs/${encodeURIComponent(jobId)}/jobRuns/${encodeURIComponent(runId)}/status`));
  }
  redactDiagnostic(value) {
    let text = String(value ?? "");
    for (const secret of [this.opts.credentials.password, this.opts.credentials.username, this.token].filter((v) => Boolean(v))) text = text.split(secret).join("[redacted]");
    return text.replace(/\b(password|authToken|authorization|token|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]").replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email redacted]").slice(0, 2e3);
  }
  async getJobRunLogs(jobId, runId) {
    const body = await this.json(await this.request("GET", `/rest/api/v1.3/connectJobs/${encodeURIComponent(jobId)}/jobRuns/${encodeURIComponent(runId)}/logs`));
    const list = Array.isArray(body) ? body : body?.logs;
    if (!Array.isArray(list)) throw new ResponsysError("Unexpected Connect logs response", "invalid_response");
    const rows = list.filter((v) => v && typeof v === "object").map((v) => {
      const rawTime = typeof v.logTime === "string" || typeof v.logTime === "number" ? v.logTime : null;
      const time = rawTime === null ? NaN : typeof rawTime === "number" || /^\d{13}$/.test(rawTime) ? Number(rawTime) : Date.parse(rawTime);
      return { logLevel: String(v.logLevel ?? "INFO").slice(0, 30), logMessage: this.redactDiagnostic(v.logMessage), logTime: Number.isFinite(time) && !Number.isNaN(new Date(time).getTime()) ? new Date(time).toISOString() : null };
    });
    return rows.sort((a, b) => (a.logTime ?? "").localeCompare(b.logTime ?? "")).slice(-50);
  }
  async createPerformanceRequest(channel, range) {
    const res = await this.request("POST", `/rest/asyncApi/v1.3/performanceAnalytics/campaigns/${channel}`, { json: range });
    const body = await this.json(res);
    if (typeof body.requestId !== "string" && typeof body.requestId !== "number") throw new ResponsysError("The reporting request was not accepted (no requestId)", "invalid_response", res.status);
    return String(body.requestId);
  }
  /** HTTP 202 (or a pending status) means accepted, not complete. */
  async pollPerformanceRequest(requestId) {
    const res = await this.request("GET", `/rest/asyncApi/v1.3/performanceAnalytics/requests/${encodeURIComponent(requestId)}`);
    if (res.status === 202) return { state: "pending" };
    let bytes = await readBounded(res, this.opts.maxResponseBytes ?? 20 * 1024 * 1024);
    const flagged = /gzip/i.test(res.headers.get("responsys-content-encoding") ?? "");
    if (flagged || bytes[0] === 31 && bytes[1] === 139) {
      try {
        bytes = gunzipSync(bytes, { maxOutputLength: this.opts.maxResponseBytes ?? 100 * 1024 * 1024 });
      } catch (e) {
        if (!(flagged && bytes[0] === 123)) throw new ResponsysError(`Could not decompress the reporting result: ${e.message}`, "invalid_response");
      }
    }
    let payload;
    try {
      payload = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new ResponsysError("The reporting result is not valid JSON", "invalid_response");
    }
    const status = String(payload?.status ?? "").toUpperCase();
    if (["PENDING", "IN_PROGRESS", "RUNNING", "SUBMITTED", "QUEUED"].includes(status)) return { state: "pending" };
    if (["FAILED", "ERROR"].includes(status)) throw new ResponsysError(`Responsys reported the request as ${status}`, "server");
    return { state: "complete", payload, bytes: bytes.length };
  }
};
async function readBounded(res, max) {
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > max) throw new ResponsysError("The Responsys response is larger than the allowed limit", "invalid_response");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > max) throw new ResponsysError("The Responsys response is larger than the allowed limit", "invalid_response");
  return buf;
}
async function classify(res) {
  const s = res.status;
  const body = await res.json().catch(() => null);
  const code = typeof body?.errorCode === "string" && /^[A-Z0-9_]{1,100}$/.test(body.errorCode) ? body.errorCode : null;
  if (code === "API_DISABLED_FOR_USER" || code === "CONNECT_DISABLED_FOR_USER") return new ResponsysError(`${code}: Ask your Responsys administrator to enable this API capability for the API user`, "permission", s);
  if (s === 401) return new ResponsysError("Responsys authentication failed", "auth", s);
  if (s === 403) return new ResponsysError("The API user is not permitted to use this operation", "permission", s);
  if (s === 404) return new ResponsysError("Not found in Responsys", "not_found", s);
  if (s === 429) {
    const header = res.headers.get("retry-after");
    const ra = header && !/^\d+$/.test(header) ? Math.ceil((Date.parse(header) - Date.now()) / 1e3) : Number(header);
    return new ResponsysError("Responsys rate limit reached", "rate_limited", s, Number.isFinite(ra) && ra > 0 ? ra : void 0);
  }
  if (s >= 500) return new ResponsysError(`Responsys server error (${s})`, "server", s);
  return new ResponsysError(`Unexpected Responsys response (${s})`, "invalid_response", s);
}
var ROW_ALIASES = {
  campaignName: ["campaignname", "campaign", "name"],
  campaignId: ["campaignid"],
  launchId: ["launchid"],
  launchDate: ["launchdate", "senddate", "sentdate", "launchtime"],
  sent: ["sent", "totalsent"],
  delivered: ["delivered", "totaldelivered"],
  bounces: ["bounced", "bounces", "totalbounced"],
  totalOpens: ["totalopens", "opened"],
  uniqueOpens: ["uniqueopens"],
  totalClicks: ["totalclicks", "clicked"],
  uniqueClicks: ["uniqueclicks"],
  conversionEvents: ["conversions", "totalconversions"],
  revenue: ["revenue", "totalrevenue"],
  unsubscribes: ["unsubscribes", "optouts", "optedout"],
  complaints: ["complaints"]
};
var norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
function extractReportingRows(payload) {
  const findArray = (v, depth = 0) => {
    if (Array.isArray(v)) return v.every((x) => x && typeof x === "object") ? v : null;
    if (v && typeof v === "object" && depth < 3) for (const x of Object.values(v)) {
      const a = findArray(x, depth + 1);
      if (a) return a;
    }
    return null;
  };
  const list = findArray(payload);
  if (!list) return { rows: [], unknownShape: true };
  const rows = [];
  for (const raw of list) {
    const byNorm = new Map(Object.entries(raw).map(([k, v]) => [norm(k), v]));
    const get = (field) => {
      for (const a of ROW_ALIASES[field]) if (byNorm.has(a)) return byNorm.get(a);
      return void 0;
    };
    const name = get("campaignName");
    const date2 = String(get("launchDate") ?? "").slice(0, 10);
    if (typeof name !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date2)) return { rows: [], unknownShape: true };
    const measures = {};
    for (const f of ["sent", "delivered", "bounces", "totalOpens", "uniqueOpens", "totalClicks", "uniqueClicks", "conversionEvents", "revenue", "unsubscribes", "complaints"]) {
      const v = get(f);
      measures[f] = v === void 0 || v === null || v === "" ? null : /^-?\d+(\.\d+)?$/.test(String(v)) ? String(v) : null;
    }
    const id = get("campaignId");
    const launch = get("launchId");
    rows.push({ campaignName: name, campaignId: id === void 0 ? null : String(id), launchId: launch === void 0 ? null : String(launch), launchDate: date2, measures });
  }
  return { rows, unknownShape: false };
}
function resolveCredentials(cfg, ref) {
  const [kind, name] = ref.split(":");
  if (kind === "env") {
    const key = name.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
    const username = process.env[`RESPONSYS_${key}_USERNAME`];
    const password = process.env[`RESPONSYS_${key}_PASSWORD`];
    if (username && password) return { username, password };
  } else if (kind === "file" && cfg.RESPONSYS_CREDENTIALS_FILE) {
    try {
      const all = JSON.parse(readFileSync(cfg.RESPONSYS_CREDENTIALS_FILE, "utf8"));
      const c = all[name];
      if (c?.username && c?.password) return { username: c.username, password: c.password };
    } catch {
    }
  }
  throw new ResponsysError(`No credentials are available for reference "${ref}" on the server`, "credentials_missing");
}
function createResponsysFactory(cfg) {
  return (conn) => new ResponsysClient({
    loginBaseUrl: conn.loginBaseUrl,
    credentials: resolveCredentials(cfg, conn.credentialRef),
    allowedHostSuffixes: cfg.responsysAllowedHostSuffixes
  });
}

// server/modules/connections/sync.ts
import { randomUUID as randomUUID2 } from "node:crypto";
async function loadConn(tx, id) {
  const { rows } = await tx.query(
    `SELECT c.id, c.account_id, c.login_base_url, c.credential_ref, c.status, c.reporting_dataset_id, a.timezone, a.currency, c.created_by
       FROM connections c JOIN accounts a ON a.id = c.account_id WHERE c.id = $1`,
    [id]
  );
  if (!rows[0]) throw new PermanentJobError("Connection not found");
  return rows[0];
}
var safeError = (e) => (e instanceof ResponsysError ? `${e.kind}: ${e.message}` : "unexpected error").slice(0, 300);
async function probe(fn) {
  try {
    await fn();
    return { status: "available", detail: null };
  } catch (e) {
    if (e instanceof ResponsysError && e.kind === "permission") return { status: "denied", detail: e.message };
    return { status: "unavailable", detail: safeError(e) };
  }
}
function checkHandler(factory) {
  return async (job, { db }) => {
    const t = { workspaceId: job.workspace_id };
    const conn = await db.withTenant(t, (tx) => loadConn(tx, String(job.payload.connectionId)));
    let status;
    let lastError = null;
    const capabilities = {};
    let endpoint = null;
    const now = (/* @__PURE__ */ new Date()).toISOString();
    try {
      const client = factory({ loginBaseUrl: conn.login_base_url, credentialRef: conn.credential_ref });
      await client.authenticate();
      endpoint = client.serviceEndpoint;
      capabilities.authentication = { status: "available", detail: null, checkedAt: now };
      const checks = [
        ["rate_limits", () => client.getRateLimits()],
        ["campaign_metadata", () => client.listCampaigns(1, 0)],
        ["connect_jobs", () => client.listConnectJobs()]
      ];
      for (const [key, fn] of checks) capabilities[key] = { ...await probe(fn), checkedAt: now };
      capabilities.reporting = { status: "unverified", detail: "Verified by the first reporting sync", checkedAt: now };
      status = Object.values(capabilities).some((c) => c.status === "denied" || c.status === "unavailable") ? "degraded" : "available";
    } catch (e) {
      lastError = safeError(e);
      const kind = e instanceof ResponsysError ? e.kind : "unknown";
      status = kind === "auth" || kind === "credentials_missing" ? "denied" : "unavailable";
      capabilities.authentication = { status: "unavailable", detail: lastError, checkedAt: now };
    }
    await db.withTenant(t, async (tx) => {
      await tx.query(
        `UPDATE connections SET status = $2, capabilities = capabilities || $3::jsonb, last_checked_at = now(), last_error = $4, service_endpoint = COALESCE($5, service_endpoint) WHERE id = $1`,
        [conn.id, status, JSON.stringify(capabilities), lastError, endpoint]
      );
      await audit(tx, { workspaceId: job.workspace_id, userId: job.created_by }, "connection.check", { type: "connection", id: conn.id }, status === "available" ? "success" : "failure", { status });
      await publishEvent(tx, { workspaceId: job.workspace_id, accountId: conn.account_id, type: "connection.health", resourceId: conn.id, payload: { status } });
    });
    return { status };
  };
}
var RUN_STATUS = { running: "running", succeeded: "succeeded", success: "succeeded", failed: "failed", failure: "failed", aborted: "aborted" };
function categorizeError(message) {
  if (!message) return null;
  const m = message.toLowerCase();
  if (/no such file|not found|missing file|file does not exist|no files? (?:were |was )?found/.test(m)) return "missing_source_file";
  if (/column|header|schema|field/.test(m)) return "schema_mismatch";
  if (/encoding|charset|utf/.test(m)) return "encoding";
  if (/date|format/.test(m)) return "data_format";
  if (/sftp|ssh|connection|timeout|auth/.test(m)) return "transfer_or_auth";
  return "other";
}
var str = (v) => v === void 0 || v === null ? null : String(v);
var num = (v) => v === void 0 || v === null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);
var date = (v) => {
  if (v === void 0 || v === null || v === "") return null;
  const d = new Date(typeof v === "number" ? v : /^\d{13}$/.test(String(v)) ? Number(v) : String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
async function syncConnect(db, t, conn, client, fromIso, toIso, heartbeat = async () => {
}) {
  const jobs = await client.listConnectJobs();
  let runs = 0;
  const warnings = [];
  for (const j of jobs) {
    await heartbeat();
    const extId = str(j.jobId ?? j.id);
    if (!extId) continue;
    const name = str(j.jobName ?? j.name) ?? extId;
    const type = str(j.jobType ?? j.type);
    const isFeed = /event\s*feed|ced|eventdata/i.test(`${type ?? ""} ${name}`);
    const jobRow = await db.withTenant(
      t,
      (tx) => tx.query(
        `INSERT INTO connect_jobs (workspace_id, account_id, connection_id, external_job_id, name, job_type, is_event_feed, raw)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (connection_id, external_job_id) DO UPDATE SET name = EXCLUDED.name, job_type = EXCLUDED.job_type,
           is_event_feed = EXCLUDED.is_event_feed, raw = EXCLUDED.raw, last_synced_at = now() RETURNING id`,
        [t.workspaceId, conn.account_id, conn.id, extId, name, type, isFeed, JSON.stringify(redact(j))]
      )
    );
    let list = [];
    try {
      list = await client.listJobRuns(extId, fromIso, toIso);
    } catch (e) {
      if (e instanceof ResponsysError && (e.kind === "permission" || e.kind === "not_found")) {
        warnings.push(`Job ${extId}: ${safeError(e)}`);
        continue;
      }
      throw e;
    }
    for (const r of list) {
      const runId = str(r.jobRunId ?? r.runId ?? r.id);
      if (!runId) continue;
      await heartbeat();
      let detail = {};
      const detailWarnings = [];
      try {
        detail = await client.getJobRunStatus(extId, runId);
      } catch (e) {
        if (!(e instanceof ResponsysError) || e.retryable || e.kind === "auth") throw e;
        detailWarnings.push(`Run status unavailable: ${safeError(e)}`);
      }
      const value = detail.jobRunStatus ?? r.jobRunStatus ?? r.status;
      const providerState = str(value && typeof value === "object" ? value.value : value);
      const status = RUN_STATUS[(providerState ?? "").toLowerCase()] ?? "unknown";
      let logs = [];
      if (["failed", "aborted"].includes(status)) {
        try {
          logs = await client.getJobRunLogs(extId, runId);
        } catch (e) {
          if (!(e instanceof ResponsysError) || e.retryable || e.kind === "auth") throw e;
          detailWarnings.push(`Run logs unavailable: ${safeError(e)}`);
        }
      }
      const logError = logs.filter((l) => /error|fatal/i.test(l.logLevel)).map((l) => l.logMessage).join("\n");
      const errorValue = detail.errorMessage || detail.errrorMessage || r.errorMessage || r.errrorMessage || logError;
      const errorText = errorValue ? client.redactDiagnostic(errorValue) : null;
      const started = date(r.jobStartTime ?? r.startTime ?? r.startedAt);
      const duration = num(detail.durationInSeconds ?? r.durationInSeconds);
      const ended = date(r.endTime ?? r.endedAt) ?? (started && duration !== null && duration >= 0 && status !== "running" ? new Date(Date.parse(started) + duration * 1e3).toISOString() : null);
      warnings.push(...detailWarnings.map((w) => `Job ${extId}, run ${runId}: ${w}`));
      await db.withTenant(
        t,
        (tx) => tx.query(
          `INSERT INTO connect_job_runs (workspace_id, connect_job_id, external_run_id, provider_state, status, started_at, ended_at, records_processed, records_rejected, error_category, error_redacted, raw)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (connect_job_id, external_run_id) DO UPDATE SET provider_state = EXCLUDED.provider_state, status = EXCLUDED.status,
             started_at = EXCLUDED.started_at, ended_at = EXCLUDED.ended_at, records_processed = EXCLUDED.records_processed, records_rejected = EXCLUDED.records_rejected,
             error_category = EXCLUDED.error_category, error_redacted = EXCLUDED.error_redacted, raw = EXCLUDED.raw, synced_at = now()`,
          [
            t.workspaceId,
            jobRow.rows[0].id,
            runId,
            providerState,
            status,
            started,
            ended,
            num(detail.recordsProcessed ?? r.recordsProcessed),
            num(detail.recordsRejected ?? r.recordsRejected ?? r.recordsFailed),
            categorizeError(errorText),
            errorText,
            JSON.stringify({ _diagnostics: { logs, warning: detailWarnings.length ? detailWarnings.join("; ") : null } })
          ]
        )
      );
      runs++;
    }
  }
  return { jobs: jobs.length, runs, warnings };
}
function connectPullHandler(factory) {
  return async (job, { db, heartbeat }) => {
    const t = { workspaceId: job.workspace_id };
    const conn = await db.withTenant(t, (tx) => loadConn(tx, String(job.payload.connectionId)));
    if (conn.status === "disabled") throw new PermanentJobError("Connection is disabled");
    const mark = async (status, detail) => db.withTenant(t, async (tx) => {
      await tx.query(`UPDATE connections SET capabilities = jsonb_set(capabilities, '{connect_sync}', $2::jsonb) WHERE id = $1`, [conn.id, JSON.stringify({ status, detail, checkedAt: (/* @__PURE__ */ new Date()).toISOString() })]);
      await publishEvent(tx, { workspaceId: t.workspaceId, accountId: conn.account_id, type: "connection.health", resourceId: conn.id, payload: { status } });
    });
    await mark("running", "Pulling Connect jobs, run status and failure logs");
    try {
      const client = factory({ loginBaseUrl: conn.login_base_url, credentialRef: conn.credential_ref });
      const out = await syncConnect(db, t, conn, client, String(job.payload.from), String(job.payload.to), heartbeat);
      await mark(out.warnings.length ? "partial" : "available", `Pulled ${out.jobs} jobs and ${out.runs} runs` + (out.warnings.length ? `. ${out.warnings.length} history/detail requests were unavailable. Charts include retrieved runs. ${out.warnings.slice(0, 5).join("; ")}` : ""));
      return out;
    } catch (e) {
      await mark("unavailable", safeError(e));
      if (e instanceof ResponsysError && !e.retryable) throw new PermanentJobError(safeError(e));
      throw e;
    }
  };
}
function planPartitions(fromIso, toIso, maxDays = REPORTING_MAX_SPAN_DAYS) {
  const out = [];
  let start = fromIso;
  while (start <= toIso) {
    const endCandidate = addDays(start, maxDays - 1);
    const end = endCandidate < toIso ? endCandidate : toIso;
    out.push({ from: start, to: end });
    start = addDays(end, 1);
  }
  return out;
}
var SUBMISSIONS_PER_MINUTE = 5;
async function submitDue(db, t, conn, client, syncRunId) {
  const planned = await db.withTenant(
    t,
    (tx) => tx.query(
      `SELECT id, channel, send_from_date, send_to_date FROM reporting_requests WHERE sync_run_id = $1 AND status = 'planned' ORDER BY send_from_date`,
      [syncRunId]
    )
  );
  for (const p of planned.rows) {
    const recent = await db.withTenant(
      t,
      (tx) => tx.query(`SELECT count(*)::int AS n FROM reporting_requests WHERE connection_id = $1 AND submitted_at > now() - interval '1 minute'`, [conn.id])
    );
    if (recent.rows[0].n >= SUBMISSIONS_PER_MINUTE) return false;
    const requestId = await client.createPerformanceRequest(p.channel, { sendFromDate: p.send_from_date, sendToDate: p.send_to_date });
    await db.withTenant(
      t,
      (tx) => tx.query(`UPDATE reporting_requests SET status = 'submitted', provider_request_id = $2, attempts = attempts + 1, submitted_at = now(), updated_at = now() WHERE id = $1`, [p.id, requestId])
    );
  }
  return true;
}
async function pollSubmitted(db, t, client, syncRunId) {
  const open = await db.withTenant(
    t,
    (tx) => tx.query(
      `SELECT id, provider_request_id, send_from_date, send_to_date, channel, connection_id, account_id FROM reporting_requests
        WHERE sync_run_id = $1 AND status IN ('submitted', 'pending')`,
      [syncRunId]
    )
  );
  for (const p of open.rows) {
    const res = await client.pollPerformanceRequest(p.provider_request_id);
    if (res.state === "pending") {
      await db.withTenant(t, (tx) => tx.query(`UPDATE reporting_requests SET status = 'pending', updated_at = now() WHERE id = $1`, [p.id]));
      continue;
    }
    const { rows, unknownShape } = extractReportingRows(res.payload);
    if (unknownShape) {
      await db.withTenant(
        t,
        (tx) => tx.query(`UPDATE reporting_requests SET status = 'failed', error = $2, bytes = $3, updated_at = now() WHERE id = $1`, [
          p.id,
          "The reporting result did not match a recognised row schema (campaign name and launch date are required); nothing was imported.",
          res.bytes
        ])
      );
      continue;
    }
    if (rows.length >= REPORTING_ROW_CEILING) {
      const days = diffDays(p.send_from_date, addDays(p.send_to_date, 1));
      await db.withTenant(t, async (tx) => {
        if (days <= 1) {
          await tx.query(`UPDATE reporting_requests SET status = 'failed', row_count = $2, error = $3, updated_at = now() WHERE id = $1`, [
            p.id,
            rows.length,
            `One day returned ${REPORTING_ROW_CEILING.toLocaleString("en-US")} rows (the documented ceiling); the result may be incomplete and was not imported.`
          ]);
          return;
        }
        const mid = addDays(p.send_from_date, Math.floor(days / 2) - 1);
        await tx.query(`UPDATE reporting_requests SET status = 'split', row_count = $2, updated_at = now() WHERE id = $1`, [p.id, rows.length]);
        for (const [from, to] of [[p.send_from_date, mid], [addDays(mid, 1), p.send_to_date]]) {
          await tx.query(
            `INSERT INTO reporting_requests (workspace_id, connection_id, account_id, channel, send_from_date, send_to_date, status, sync_run_id) VALUES ($1, $2, $3, $4, $5, $6, 'planned', $7)`,
            [t.workspaceId, p.connection_id, p.account_id, p.channel, from, to, syncRunId]
          );
        }
      });
      continue;
    }
    await db.withTenant(
      t,
      (tx) => tx.query(`UPDATE reporting_requests SET status = 'received', row_count = $2, bytes = $3, result = $4, updated_at = now() WHERE id = $1`, [p.id, rows.length, res.bytes, JSON.stringify(rows)])
    );
  }
}
async function activateReporting(db, t, conn, syncRunId, from, to, actorId) {
  return db.withTenant(t, async (tx) => {
    const parts2 = await tx.query(
      `SELECT id, result FROM reporting_requests WHERE sync_run_id = $1 AND status = 'received'`,
      [syncRunId]
    );
    let datasetId = conn.reporting_dataset_id;
    if (!datasetId) {
      const ds = await tx.query(
        `INSERT INTO datasets (workspace_id, account_id, name, source_type, grain, time_basis, created_by) VALUES ($1, $2, 'Responsys reporting (email)', 'responsys_reporting', 'campaign_launch', 'send_cohort', $3) RETURNING id`,
        [t.workspaceId, conn.account_id, actorId]
      );
      datasetId = ds.rows[0].id;
      await tx.query("UPDATE connections SET reporting_dataset_id = $2 WHERE id = $1", [conn.id, datasetId]);
    }
    const prev = await tx.query(
      `SELECT id, coverage_start, coverage_end_exclusive FROM dataset_versions WHERE dataset_id = $1 AND status = 'active'`,
      [datasetId]
    );
    const next = await tx.query("SELECT COALESCE(MAX(version), 0) + 1 AS v FROM dataset_versions WHERE dataset_id = $1", [datasetId]);
    const endEx = addDays(to, 1);
    const p = prev.rows[0];
    const covStart = p?.coverage_start && p.coverage_start < from ? p.coverage_start : from;
    const covEnd = p?.coverage_end_exclusive && p.coverage_end_exclusive > endEx ? p.coverage_end_exclusive : endEx;
    const ver = await tx.query(
      `INSERT INTO dataset_versions (workspace_id, dataset_id, account_id, version, status, timezone, currency, source_as_of, coverage_start, coverage_end_exclusive, quality, content_signature, created_by)
       VALUES ($1, $2, $3, $4, 'staged', $5, $6, now(), $7, $8, $9, $10, $11) RETURNING id`,
      [
        t.workspaceId,
        datasetId,
        conn.account_id,
        next.rows[0].v,
        conn.timezone,
        conn.currency,
        covStart,
        covEnd,
        JSON.stringify({ limitations: ["Provider-attributed aggregate reporting; field meanings follow Oracle's reporting definitions."], semantics: { source: "responsys_reporting" } }),
        `sync:${syncRunId}`,
        actorId
      ]
    );
    const versionId = ver.rows[0].id;
    if (p) {
      await tx.query(
        `INSERT INTO campaign_launch_facts (workspace_id, account_id, dataset_version_id, campaign_id, launch_external_id, channel, launch_date, fact_date, campaign_name, program, subject_line, currency,
           sent, delivered, skipped, bounces, total_opens, unique_opens, total_clicks, unique_clicks, conversion_events, orders, revenue, unsubscribes, complaints, source_row)
         SELECT workspace_id, account_id, $2, campaign_id, launch_external_id, channel, launch_date, fact_date, campaign_name, program, subject_line, currency,
           sent, delivered, skipped, bounces, total_opens, unique_opens, total_clicks, unique_clicks, conversion_events, orders, revenue, unsubscribes, complaints, source_row
           FROM campaign_launch_facts WHERE dataset_version_id = $1 AND (launch_date < $3 OR launch_date >= $4)`,
        [p.id, versionId, from, endEx]
      );
    }
    let row = 0;
    const seen = /* @__PURE__ */ new Set();
    for (const part of parts2.rows) {
      for (const r of part.result) {
        const ext = r.campaignId ?? r.campaignName;
        const key = `${ext}|${r.launchId ?? ""}|${r.launchDate}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const camp = await tx.query(
          `INSERT INTO campaigns (workspace_id, account_id, external_id, name, channel) VALUES ($1, $2, $3, $4, 'Email')
           ON CONFLICT (workspace_id, account_id, external_id) DO UPDATE SET updated_at = now() RETURNING id`,
          [t.workspaceId, conn.account_id, ext.slice(0, 200), r.campaignName]
        );
        const m = r.measures;
        await tx.query(
          `INSERT INTO campaign_launch_facts (workspace_id, account_id, dataset_version_id, campaign_id, launch_external_id, channel, launch_date, campaign_name, currency,
             sent, delivered, bounces, total_opens, unique_opens, total_clicks, unique_clicks, conversion_events, revenue, unsubscribes, complaints, source_row)
           VALUES ($1, $2, $3, $4, $5, 'Email', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
          [
            t.workspaceId,
            conn.account_id,
            versionId,
            camp.rows[0].id,
            r.launchId,
            r.launchDate,
            r.campaignName,
            conn.currency,
            m.sent,
            m.delivered,
            m.bounces,
            m.totalOpens,
            m.uniqueOpens,
            m.totalClicks,
            m.uniqueClicks,
            m.conversionEvents,
            m.revenue,
            m.unsubscribes,
            m.complaints,
            ++row
          ]
        );
      }
    }
    const count = await tx.query("SELECT count(*)::int AS n FROM campaign_launch_facts WHERE dataset_version_id = $1", [versionId]);
    await tx.query("UPDATE dataset_versions SET row_count = $2 WHERE id = $1", [versionId, count.rows[0].n]);
    await tx.query(`UPDATE reporting_requests SET status = 'activated', updated_at = now() WHERE sync_run_id = $1 AND status = 'received'`, [syncRunId]);
    const revision = await activateVersion(tx, { workspaceId: t.workspaceId, userId: actorId }, datasetId, versionId, "sync");
    await tx.query(`UPDATE connections SET last_successful_sync_at = now(), capabilities = jsonb_set(capabilities, '{reporting}', $2) WHERE id = $1`, [
      conn.id,
      JSON.stringify({ status: "available", detail: null, checkedAt: (/* @__PURE__ */ new Date()).toISOString() })
    ]);
    return { datasetId, versionId, revision, rows: count.rows[0].n };
  });
}
function syncHandler(factory, cfg) {
  return async (job, { db, heartbeat }) => {
    const t = { workspaceId: job.workspace_id };
    const conn = await db.withTenant(t, (tx) => loadConn(tx, String(job.payload.connectionId)));
    if (!["available", "degraded"].includes(conn.status)) throw new PermanentJobError(`Connection is ${conn.status}; run a connection test first`);
    const client = factory({ loginBaseUrl: conn.login_base_url, credentialRef: conn.credential_ref });
    const syncRunId = String(job.payload.syncRunId ?? "") || randomUUID2();
    const today = localDate(/* @__PURE__ */ new Date(), conn.timezone);
    const to = String(job.payload.to ?? addDays(today, -1));
    const from = String(job.payload.from ?? addDays(today, -Math.max(1, cfg.SYNC_RECONCILIATION_LOOKBACK_DAYS)));
    await db.withTenant(t, (tx) => tx.query("UPDATE connections SET last_sync_attempt_at = now() WHERE id = $1", [conn.id]));
    try {
      let connect = { jobs: 0, runs: 0 };
      if (!job.payload.syncRunId) {
        try {
          connect = await syncConnect(db, t, conn, client, from, to);
        } catch (e) {
          if (e instanceof ResponsysError && !e.retryable) connect = { error: safeError(e) };
          else throw e;
        }
        await db.withTenant(t, async (tx) => {
          for (const part of planPartitions(from, to)) {
            await tx.query(
              `INSERT INTO reporting_requests (workspace_id, connection_id, account_id, channel, send_from_date, send_to_date, status, sync_run_id) VALUES ($1, $2, $3, 'email', $4, $5, 'planned', $6)`,
              [t.workspaceId, conn.id, conn.account_id, part.from, part.to, syncRunId]
            );
          }
        });
      }
      await submitDue(db, t, conn, client, syncRunId);
      await heartbeat();
      await pollSubmitted(db, t, client, syncRunId);
      const state = await db.withTenant(
        t,
        (tx) => tx.query("SELECT status, count(*)::int AS n FROM reporting_requests WHERE sync_run_id = $1 GROUP BY status", [syncRunId])
      );
      const by = Object.fromEntries(state.rows.map((r) => [r.status, r.n]));
      const outstanding = (by.planned ?? 0) + (by.submitted ?? 0) + (by.pending ?? 0);
      if (outstanding > 0) {
        await db.withTenant(
          t,
          (tx) => enqueueJob(tx, { workspaceId: t.workspaceId, type: "responsys.sync", payload: { connectionId: conn.id, syncRunId, from, to }, runAfter: new Date(Date.now() + 6e4), createdBy: job.created_by, dedupeKey: `sync-poll:${syncRunId}` })
        );
        await db.withTenant(t, (tx) => publishEvent(tx, { workspaceId: t.workspaceId, accountId: conn.account_id, type: "sync.status", resourceId: conn.id, payload: { state: "waiting_for_provider", outstanding } }));
        return { state: "waiting_for_provider", outstanding, connect };
      }
      if (by.failed) {
        await db.withTenant(t, async (tx) => {
          await tx.query("UPDATE connections SET last_error = $2 WHERE id = $1", [conn.id, `${by.failed} reporting partition(s) failed; no new version was activated`]);
          await publishEvent(tx, { workspaceId: t.workspaceId, accountId: conn.account_id, type: "sync.status", resourceId: conn.id, payload: { state: "partial_failure", failed: by.failed } });
        });
        return { state: "partial_failure", failed: by.failed, connect };
      }
      const activated = await activateReporting(db, t, conn, syncRunId, from, to, job.created_by);
      await db.withTenant(t, (tx) => publishEvent(tx, { workspaceId: t.workspaceId, accountId: conn.account_id, type: "sync.status", resourceId: conn.id, payload: { state: "completed", rows: activated.rows } }));
      return { state: "completed", ...activated, connect };
    } catch (e) {
      if (e instanceof ResponsysError) {
        await db.withTenant(t, (tx) => tx.query("UPDATE connections SET last_error = $2, status = CASE WHEN $3 THEN status ELSE $4 END WHERE id = $1", [conn.id, safeError(e), e.retryable, e.kind === "auth" ? "denied" : "degraded"]));
        if (!e.retryable) throw new PermanentJobError(safeError(e));
      }
      throw e;
    }
  };
}
function responsysJobHandlers(deps) {
  return {
    "responsys.check": checkHandler(deps.responsys),
    "responsys.connect": connectPullHandler(deps.responsys),
    "responsys.sync": syncHandler(deps.responsys, deps.cfg)
  };
}

// server/runtime.ts
async function bootstrap(opts = {}) {
  dotenv.config({ path: [".env.local", ".env"], quiet: true });
  const cfg = loadConfig();
  configureLogger({ level: cfg.LOG_LEVEL });
  const db = new Db(cfg.DATABASE_URL, opts.poolSize ?? 10, { runtimeRole: cfg.DATABASE_RUNTIME_ROLE });
  await db.assertRuntimeRoleIsSafe();
  if (cfg.STORAGE_DRIVER !== "filesystem" && !opts.storage) throw new Error(`STORAGE_DRIVER=${cfg.STORAGE_DRIVER} must be provided by the host platform`);
  const storage = opts.storage ?? new FilesystemStorage(cfg.STORAGE_ROOT);
  if (!await storage.healthy()) throw new Error(`Object storage (${cfg.STORAGE_DRIVER}) is not available`);
  const ai = createAiProvider(cfg);
  const responsys = createResponsysFactory(cfg);
  logger.info("runtime ready", { mode: cfg.APP_DATA_MODE, auth: cfg.AUTH_MODE, ai: cfg.AI_PROVIDER });
  return {
    cfg,
    db,
    storage,
    ai,
    responsys,
    runner: () => new JobRunner(db, buildHandlers({ storage, extra: responsysJobHandlers({ cfg, responsys }) }))
  };
}

// server/modules/connections/scheduler.ts
async function schedulerTick(db, cfg) {
  try {
    const { rows } = await db.query("SELECT * FROM rci_due_connections($1)", [cfg.SYNC_REPORTING_INTERVAL_MINUTES]);
    for (const r of rows) {
      await db.withTenant({ workspaceId: r.workspace_id }, async (tx) => {
        await tx.query("UPDATE connections SET last_sync_attempt_at = now() WHERE id = $1", [r.connection_id]);
        await enqueueJob(tx, { workspaceId: r.workspace_id, type: "responsys.sync", payload: { connectionId: r.connection_id }, dedupeKey: `sync:${r.connection_id}` });
      });
    }
  } catch (e) {
    logger.warn("scheduler tick failed", { error: e.message });
  }
}
function startScheduler(db, cfg) {
  const tick = () => schedulerTick(db, cfg);
  const timer = setInterval(tick, 6e4);
  void tick();
  return { stop: () => clearInterval(timer) };
}

// server/worker.ts
process.env.NODE_ENV ??= "production";
var rt = await bootstrap();
var runner = rt.runner();
runner.start();
var scheduler = startScheduler(rt.db, rt.cfg);
logger.info("worker started", { workerId: runner.workerId });
var shutdown = async (signal) => {
  logger.info("worker stopping", { signal });
  scheduler.stop();
  await runner.stop();
  await rt.db.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
//# sourceMappingURL=worker.js.map
