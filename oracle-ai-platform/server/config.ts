import "dotenv/config";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
export interface Config {
  production: boolean;
  port: number;
  origin: string;
  dataDir: string;
  databaseUrl: string;
  migrationUrl: string;
  authMode: "dev" | "oidc";
  sessionSecret: string;
  encryptionKey: Buffer;
  issuer: string;
  clientId: string;
  clientSecret: string;
  providerName: string;
  bootstrapEmail: string;
  responsysUrl: string;
  /** Development: the Responsys folder the platform starts and serves at responsys.<host>:<port>. */
  responsysDir: string;
  responsysInternalPort: number;
  responsysHost: string;
  shareAiWithResponsys: boolean;
  providerAdmins: string[];
  ssoSecret: string;
  allowedHosts: string[];
  aiProvider: string;
  aiModel: string;
  aiKey: string;
  aiBase: string;
  aiTimeout: number;
  aiLimit: number;
  worker: boolean;
  retentionDays: number;
  trustProxyHops: number;
}
export function config(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === "production",
    dataDir = resolve(env.DATA_DIR || ".data");
  const authMode = (env.AUTH_MODE || (production ? "oidc" : "dev")) as
    "dev" | "oidc";
  if (!["dev", "oidc"].includes(authMode))
    throw Error("AUTH_MODE must be dev or oidc");
  if (production && env.DATABASE_MIGRATION_URL)
    throw Error(
      "Remove DATABASE_MIGRATION_URL from the runtime. Apply migrations with the separate migration command.",
    );
  const integer = (key: string, value: number, min: number, max: number) => {
    const n = Number(env[key] || value);
    if (!Number.isInteger(n) || n < min || n > max)
      throw Error(`${key} must be an integer from ${min} to ${max}`);
    return n;
  };
  if (
    production &&
    (authMode !== "oidc" ||
      !env.DATABASE_URL ||
      !env.SESSION_SECRET ||
      !env.ENCRYPTION_KEY)
  )
    throw Error(
      "Production requires OIDC, DATABASE_URL, SESSION_SECRET and ENCRYPTION_KEY",
    );
  if (
    authMode === "oidc" &&
    (!env.OIDC_ISSUER || !env.OIDC_CLIENT_ID || !env.OIDC_CLIENT_SECRET)
  )
    throw Error("OIDC configuration is incomplete");
  // Responsys started and served by the platform (development only; one port, one sign-in).
  const responsysDir = resolveResponsysDir(env);
  if (production && responsysDir)
    throw Error(
      "RESPONSYS_DIR is for local development. In production run Responsys separately and set RESPONSYS_URL.",
    );
  let local: { session: string; key: string; sso?: string } | null = null;
  if (
    !production &&
    (!env.SESSION_SECRET ||
      !env.ENCRYPTION_KEY ||
      (responsysDir && !env.RESPONSYS_SSO_SECRET))
  ) {
    mkdirSync(dataDir, { recursive: true });
    const path = resolve(dataDir, "local-secrets.json");
    const before = existsSync(path)
      ? JSON.parse(readFileSync(path, "utf8"))
      : null;
    local = before || {
      session: randomBytes(40).toString("hex"),
      key: randomBytes(32).toString("base64"),
    };
    if (responsysDir && !local!.sso)
      local!.sso = randomBytes(32).toString("base64url");
    if (JSON.stringify(before) !== JSON.stringify(local))
      writeFileSync(path, JSON.stringify(local), { mode: 0o600 });
  }
  if (env.RESPONSYS_SSO_SECRET && env.RESPONSYS_SSO_SECRET.length < 32)
    throw Error("RESPONSYS_SSO_SECRET must be at least 32 characters");
  const sessionSecret = env.SESSION_SECRET || local!.session,
    encryptionKey = Buffer.from(env.ENCRYPTION_KEY || local!.key, "base64");
  const port = integer("PORT", 3006, 1024, 65525);

  if (sessionSecret.length < 32 || encryptionKey.length !== 32)
    throw Error(
      "Session secret must be at least 32 characters and encryption key must decode to 32 bytes",
    );
  const origin = env.APP_ORIGIN || "http://localhost:3006";
  if (production && !origin.startsWith("https://"))
    throw Error("Production APP_ORIGIN must use HTTPS");
  // gemini, or ChatGPT: "openai" / "chatgpt" are the OpenAI API (openai-compatible with its URL).
  const rawProvider = (env.AI_PROVIDER || "none").trim().toLowerCase();
  const openAiAlias = rawProvider === "openai" || rawProvider === "chatgpt";
  let aiProvider = openAiAlias ? "openai-compatible" : rawProvider;
  if (!["none", "gemini", "openai-compatible"].includes(aiProvider))
    throw Error("Unsupported AI_PROVIDER (use gemini or openai)");
  // The key may also be given under the provider's own name (as in the Responsys settings file).
  const aiKey = (
    env.AI_API_KEY ||
    (openAiAlias ? env.OPENAI_API_KEY : "") ||
    (aiProvider === "gemini" ? env.GEMINI_API_KEY : "") ||
    ""
  ).trim();
  const aiModel = (env.AI_MODEL || "").trim();
  // A key or model with spaces or invisible characters was not pasted correctly.
  const garbled = (v: string) => /[\s\x00-\x1f\x7f]/.test(v);
  if (aiProvider !== "none" && (garbled(aiKey) || garbled(aiModel))) {
    if (production)
      throw Error("AI_API_KEY or AI_MODEL contains invalid characters");
    console.warn(
      "AI is OFF: AI_API_KEY or AI_MODEL in .env contains invisible characters (it was not pasted correctly). Open .env, retype AI_MODEL, paste AI_API_KEY with Ctrl+V in the editor, save and restart.",
    );
    aiProvider = "none";
  }
  if (aiProvider !== "none" && (!aiKey || !aiModel)) {
    const missing = [!aiModel && "AI_MODEL", !aiKey && "AI_API_KEY"]
      .filter(Boolean)
      .join(" and ");
    if (production) throw Error(`Configured AI requires ${missing}`);
    // Locally the platform still starts, with AI off and the reason printed.
    console.warn(
      `AI is OFF: ${missing} is empty in oracle-ai-platform/.env. Answers are rule-based until you set it (run 1-SETUP.cmd again, or edit .env) and restart.`,
    );
    aiProvider = "none";
  }
  const responsysHost = "responsys." + new URL(origin).host;
  return {
    production,
    port,
    origin,
    dataDir,
    databaseUrl: env.DATABASE_URL || "",
    migrationUrl: env.DATABASE_MIGRATION_URL || "",
    authMode,
    sessionSecret,
    encryptionKey,
    issuer: env.OIDC_ISSUER || "",
    clientId: env.OIDC_CLIENT_ID || "",
    clientSecret: env.OIDC_CLIENT_SECRET || "",
    providerName: env.OIDC_PROVIDER_NAME || "Your organization",
    bootstrapEmail: (env.BOOTSTRAP_EMAIL || "").toLowerCase(),
    responsysUrl:
      env.RESPONSYS_URL ||
      (responsysDir ? new URL(origin).protocol + "//" + responsysHost : ""),
    responsysDir,
    responsysInternalPort: integer(
      "RESPONSYS_INTERNAL_PORT",
      port + 50,
      1024,
      65535,
    ),
    responsysHost,
    shareAiWithResponsys: env.RESPONSYS_SHARE_AI !== "false",
    // Platform provider administrators manage client companies and their subscriptions.
    providerAdmins: [
      ...(env.PLATFORM_ADMIN_EMAILS || "").split(","),
      env.BOOTSTRAP_EMAIL || "",
    ]
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    // Shared secret of the Responsys single sign-on client (never sent to browsers).
    ssoSecret: env.RESPONSYS_SSO_SECRET || local?.sso || "",
    // Approved outbound hosts, plus the host of the AI service the administrator configured.
    allowedHosts: [
      ...new Set(
        [
          ...(env.OUTBOUND_HOSTS || "").split(","),
          aiProvider === "gemini" && !env.AI_BASE_URL
            ? "generativelanguage.googleapis.com"
            : "",
          aiProvider !== "none" &&
          (env.AI_BASE_URL || (openAiAlias ? "https://api.openai.com/v1" : ""))
            ? new URL(env.AI_BASE_URL || "https://api.openai.com/v1").hostname
            : "",
        ]
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean),
      ),
    ],
    aiProvider,
    aiModel: aiProvider === "none" ? "" : aiModel,
    aiKey: aiProvider === "none" ? "" : aiKey,
    aiBase: env.AI_BASE_URL || (openAiAlias ? "https://api.openai.com/v1" : ""),
    aiTimeout: integer("AI_TIMEOUT_MS", 30000, 1000, 120000),
    aiLimit: integer("AI_DAILY_LIMIT", 100, 1, 100000),
    worker: env.RUN_WORKER === "true",
    retentionDays: integer("RETENTION_DAYS", 90, 1, 3650),
    trustProxyHops: integer("TRUST_PROXY_HOPS", 0, 0, 3),
  };
}

/**
 * RESPONSYS_DIR, or Responsys in this platform's "responsys" folder (an older layout with
 * "AIMarketing" next to the platform folder also works). The folder is used even before it is set
 * up, so the platform can say exactly which setup step is missing.
 */
function resolveResponsysDir(env: NodeJS.ProcessEnv) {
  if (env.RESPONSYS_DIR === "off") return "";
  if (env.RESPONSYS_DIR) return resolve(env.RESPONSYS_DIR);
  if (env.NODE_ENV === "test" || env.NODE_ENV === "production") return "";
  const platformDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const candidates = [
    resolve(platformDir, "responsys"),
    resolve("responsys"),
    resolve(platformDir, "..", "AIMarketing"),
    resolve("..", "AIMarketing"),
  ];
  return (
    candidates.find((dir) => existsSync(resolve(dir, "server", "dev.ts"))) || ""
  );
}
