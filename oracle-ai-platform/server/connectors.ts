import { randomBytes, createHash } from "node:crypto";
import { parse } from "csv-parse/sync";
import { z } from "zod";
import type { AppId, RecordData } from "../shared/catalog";
import type { Config } from "./config";
import { approvedUrl, boundedResponse, HttpError } from "./security";
import { validateRecords } from "./imports";
import { secureRequest } from "./http";
import { readEloqua } from "./eloqua-connector";
export const ResourceSchema = z.object({
  type: z.string(),
  path: z.string().startsWith("/").max(1000),
  itemsPath: z.string().default("items"),
  mapping: z.record(z.string(), z.string()).default({}),
  pagination: z.enum(["none", "offset", "next"]).default("none"),
  nextPath: z.string().default("next"),
  pageSize: z.number().int().min(1).max(1000).default(200),
  method: z.enum(["GET", "POST"]).default("GET"),
  body: z.unknown().optional(),
});
export const ConnectionSchema = z.object({
  baseUrl: z.url(),
  auth: z.enum(["basic", "bearer", "oauth", "unity-password", "eloqua-basic"]),
  tokenUrl: z.string().default(""),
  authorizationUrl: z.string().default(""),
  scope: z.string().default(""),
  transport: z
    .enum(["rest", "eloqua-bulk", "infinity-export", "infinity-stream"])
    .default("rest"),
  resources: z.array(ResourceSchema).max(15).default([]),
  exportUrl: z.string().default(""),
  streamUrl: z.string().default(""),
  streamMapping: z.record(z.string(), z.string()).default({}),
  streamSubscribe: z.unknown().optional(),
  streamItemsPath: z.string().default(""),
  streamWindowMinutes: z.number().int().min(1).max(1440).default(60),
  streamSnapshotSeconds: z.number().int().min(15).max(3600).default(60),
  reportMapping: z.record(z.string(), z.string()).default({}),
  providerContractConfirmed: z.boolean(),
  // Eloqua Bulk activity export settings (tenant-verified)
  activityTypes: z
    .array(z.string().regex(/^[A-Za-z]+$/))
    .max(10)
    .default([]),
  activityFieldMaps: z
    .record(z.string(), z.record(z.string(), z.string()))
    .default({}),
  backfillDays: z.number().int().min(1).max(90).default(30),
  timestampOffset: z
    .union([z.literal(""), z.string().regex(/^[+-]\d{2}:\d{2}$/)])
    .default(""),
  discoveryUrl: z.string().default(""),
  asOfPath: z.string().optional(),
});
export type ConnectorConfig = z.infer<typeof ConnectionSchema>;
export type Secrets = Record<string, string>;
export class ProviderError extends Error {
  constructor(
    message: string,
    public retryable = false,
    public retryAfter = 0,
  ) {
    super(message);
  }
}
export class PendingExport extends Error {
  constructor(public checkpoint: Record<string, unknown>) {
    super("Provider export is being prepared");
  }
}
export const at = (obj: any, path: string): any =>
  path ? path.split(".").reduce((o, k) => o?.[k], obj) : obj;
// No universal read resources are assumed for Unity or generic REST: administrators enter the
// tenant's documented paths. Eloqua uses the dedicated Bulk/Application adapter.
export const defaultResources: Record<AppId, z.infer<typeof ResourceSchema>[]> =
  {
    eloqua: [],
    unity: [],
    infinity: [],
  };
export async function request(
  url: string,
  cfg: Config,
  init: RequestInit = {},
  max = 20_000_000,
): Promise<{ response: Response; text: string }> {
  let res: Response, text: string;
  try {
    const result = await secureRequest(
      url,
      cfg,
      { ...init, signal: init.signal || AbortSignal.timeout(30000) },
      max,
    );
    res = result.response;
    text = result.text;
  } catch {
    throw new ProviderError(
      "Provider request timed out or could not connect",
      true,
    );
  }
  if (res.status >= 300 && res.status < 400)
    throw new ProviderError(
      "Provider redirect refused. Configure the verified final endpoint.",
    );
  if (res.status === 401)
    throw new ProviderError("Provider credentials expired or were refused");
  if (res.status === 403)
    throw new ProviderError("Provider denied access to this resource");
  if (res.status === 404)
    throw new ProviderError(
      "Provider resource not found or hidden by permissions",
    );
  if (res.status === 429)
    throw new ProviderError(
      "Provider rate limit reached",
      true,
      Math.min(600, Number(res.headers.get("retry-after")) || 30),
    );
  if (res.status >= 500)
    throw new ProviderError("Provider is temporarily unavailable", true);
  if (!res.ok)
    throw new ProviderError(
      `Provider rejected the request (${res.status}). Verify its documented parameters.`,
    );
  return { response: res, text };
}
export async function authorization(
  c: ConnectorConfig,
  s: Secrets,
  cfg: Config,
  save?: (s: Secrets) => Promise<void>,
): Promise<Record<string, string>> {
  if (c.auth === "basic") {
    if (!s.username || !s.password)
      throw new ProviderError("Provider username and password are required");
    return {
      Authorization:
        "Basic " +
        Buffer.from(s.username + ":" + s.password).toString("base64"),
    };
  }
  if (c.auth === "bearer") {
    if (!s.accessToken)
      throw new ProviderError("Provider access token is required");
    return { Authorization: "Bearer " + s.accessToken };
  }
  if (s.accessToken && Number(s.expiresAt) > Date.now() + 60000)
    return { Authorization: "Bearer " + s.accessToken };
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };
  const body = new URLSearchParams();
  if (c.auth === "eloqua-basic")
    throw new ProviderError(
      "Eloqua basic authentication is handled by the Eloqua adapter",
    );
  {
    if (!s.clientId || !s.clientSecret)
      throw new ProviderError("OAuth client ID and secret are required");
    headers.Authorization =
      "Basic " +
      Buffer.from(s.clientId + ":" + s.clientSecret).toString("base64");
    if (s.refreshToken) {
      body.set("grant_type", "refresh_token");
      body.set("refresh_token", s.refreshToken);
    } else if (c.auth === "unity-password") {
      if (!s.username || !s.password)
        throw new ProviderError(
          "Unity integration user credentials are required",
        );
      body.set("grant_type", "password");
      body.set("username", s.username);
      body.set("password", s.password);
      body.set("scope", c.scope);
    } else throw new ProviderError("Authorize this source connection first");
  }
  if (!c.tokenUrl)
    throw new ProviderError("A verified token endpoint is required");
  const res = await request(c.tokenUrl, cfg, { method: "POST", headers, body });
  let token: any;
  try {
    token = JSON.parse(res.text);
  } catch {
    throw new ProviderError("Token endpoint returned invalid JSON");
  }
  if (!token.access_token)
    throw new ProviderError("Token response is missing access_token");
  const next = {
    ...s,
    accessToken: token.access_token,
    refreshToken: token.refresh_token || s.refreshToken || "",
    expiresAt: String(Date.now() + Number(token.expires_in || 300) * 1000),
  };
  if (save) await save(next);
  return { Authorization: "Bearer " + next.accessToken };
}
export function canonical(
  raw: any[],
  type: string,
  mapping: Record<string, string>,
) {
  return raw.map((row) => {
    if (!Object.keys(mapping).length) return { ...row, type };
    const out: Record<string, unknown> = { type };
    for (const [field, path] of Object.entries(mapping))
      out[field] = at(row, path);
    return out;
  });
}
function verified(app: AppId, raw: any[]) {
  const result = validateRecords(app, raw);
  if (result.errors.length)
    throw new ProviderError(
      `Source mapping failed on row ${result.errors[0].row}: ${result.errors[0].message}`,
    );
  return result.records;
}
export async function readSource(
  app: AppId,
  c: ConnectorConfig,
  secrets: Secrets,
  cfg: Config,
  opts: {
    checkpoint?: Record<string, unknown>;
    saveSecrets?: (s: Secrets) => Promise<void>;
    saveCheckpoint?: (cp: Record<string, unknown>) => Promise<void>;
    checkOnly?: boolean;
  } = {},
): Promise<{
  records: RecordData[];
  capabilities: Record<string, unknown>;
  asOf: string;
  metadata: Record<string, unknown>;
}> {
  if (!c.providerContractConfirmed)
    throw new ProviderError(
      "Confirm the endpoint, field mapping, permissions and source semantics before connecting",
    );
  if (c.transport === "eloqua-bulk") {
    if (app !== "eloqua")
      throw new ProviderError("Eloqua transport belongs to an Eloqua source");
    return readEloqua(c, secrets, cfg, {
      checkpoint: opts.checkpoint,
      checkOnly: opts.checkOnly,
      saveCheckpoint: opts.saveCheckpoint,
    });
  }
  const headers = {
    Accept: "application/json",
    ...(await authorization(c, secrets, cfg, opts.saveSecrets)),
  };
  const capabilities: Record<string, unknown> = {
    authentication: { state: "available", checkedAt: new Date().toISOString() },
  };
  if (c.transport === "infinity-stream")
    throw new ProviderError(
      "Streams are consumed by the persistent worker. Use Start sync after configuring the verified stream contract.",
    );
  if (c.transport === "infinity-export") {
    const first = !opts.checkpoint?.exportUrl;
    const url = new URL(String(opts.checkpoint?.exportUrl || c.exportUrl));
    if (first && !opts.checkOnly) url.searchParams.set("refresh", "true");
    else url.searchParams.delete("refresh");
    url.searchParams.set("format", "json");
    const startedAt = String(
      opts.checkpoint?.startedAt || new Date().toISOString(),
    );
    if (Date.now() - Date.parse(startedAt) > 30 * 60000)
      throw new ProviderError(
        "Infinity export did not complete within 30 minutes. Review the report scope and retry.",
      );
    const result = await request(url.toString(), cfg, { headers });
    let payload: any;
    try {
      payload = JSON.parse(result.text);
    } catch {
      if (
        result.response.status === 202 ||
        /being processed|processing your|report is being|preparing/i.test(
          result.text,
        )
      )
        throw new PendingExport({ exportUrl: c.exportUrl, startedAt });
      throw new ProviderError(
        "Infinity returned an unrecognized export. Verify its JSON export schema.",
      );
    }
    if (
      result.response.status === 202 ||
      ["pending", "processing"].includes(payload?.status)
    )
      throw new PendingExport({ exportUrl: c.exportUrl, startedAt });
    const resource = c.resources[0];
    if (!resource)
      throw new ProviderError(
        "Configure the export itemsPath and canonical aggregate field mapping",
      );
    const data = at(payload, resource.itemsPath);
    if (!Array.isArray(data))
      throw new ProviderError("Export itemsPath does not identify an array");
    if (data.length >= 25000)
      throw new ProviderError(
        "Export reached the application limit. Configure a smaller documented date/dimension partition.",
      );
    const records = verified(
      app,
      canonical(data, resource.type, resource.mapping),
    );
    return {
      records,
      capabilities: {
        ...capabilities,
        report_export: { state: "available", rows: records.length },
      },
      asOf: startedAt,
      metadata: {
        transport: "infinity-export",
        requestedAt: startedAt,
        providerContract: "Configured saved report export",
        completeThrough: null,
      },
    };
  }
  if (!c.resources.length)
    throw new ProviderError(
      "Configure at least one documented read resource and its field mapping",
    );
  const records: RecordData[] = [];
  for (const resource of c.resources) {
    let offset = 0,
      next: string | null = new URL(resource.path, c.baseUrl).toString(),
      pages = 0;
    const seen = new Set<string>();
    while (next) {
      if (++pages > 100)
        throw new ProviderError(
          "Read exceeded 100 pages. Narrow the source scope.",
        );
      if (seen.has(next) && resource.pagination !== "offset")
        throw new ProviderError("Provider returned a repeating page cursor");
      seen.add(next);
      const url: URL = new URL(next);
      if (url.origin !== new URL(c.baseUrl).origin)
        throw new ProviderError("Pagination changed provider origin");
      if (resource.pagination === "offset") {
        url.searchParams.set("limit", String(resource.pageSize));
        url.searchParams.set("offset", String(offset));
      }
      const response = await request(url.toString(), cfg, {
        method: resource.method,
        headers: { ...headers, "Content-Type": "application/json" },
        body:
          resource.method === "POST"
            ? JSON.stringify(resource.body || {})
            : undefined,
      });
      let json: any;
      try {
        json = JSON.parse(response.text);
      } catch {
        throw new ProviderError("Provider returned invalid JSON");
      }
      const page = at(json, resource.itemsPath);
      if (!Array.isArray(page))
        throw new ProviderError(
          `Unexpected ${resource.type} response: itemsPath must select an array`,
        );
      records.push(
        ...verified(app, canonical(page, resource.type, resource.mapping)),
      );
      if (records.length > 25000)
        throw new ProviderError(
          "Read exceeds 25,000 rows. Configure a narrower authorized scope.",
        );
      capabilities[resource.type] = {
        state: "available",
        checkedAt: new Date().toISOString(),
        pages,
        records: records.filter((r) => r.type === resource.type).length,
      };
      if (opts.checkOnly) break;
      if (resource.pagination === "offset") {
        offset += page.length;
        if (json.hasMore === true && page.length === 0)
          throw new ProviderError(
            "Provider reported more rows but returned an empty page",
          );
        next = json.hasMore === true ? url.toString() : null;
        if (json.hasMore === undefined && page.length === resource.pageSize)
          throw new ProviderError(
            "Pagination completion is ambiguous; confirm the provider hasMore contract",
          );
      } else if (resource.pagination === "next") {
        const link = at(json, resource.nextPath);
        next =
          typeof link === "string" && link
            ? new URL(link, c.baseUrl).toString()
            : null;
      } else {
        if (json.hasMore === true)
          throw new ProviderError(
            "Provider returned truncated data; configure pagination",
          );
        next = null;
      }
    }
  }
  // Validate across pages too: duplicate IDs can indicate unstable pagination.
  const checked = validateRecords(app, records);
  if (checked.errors.length)
    throw new ProviderError(
      "Duplicate or invalid records across source pages; dataset was not activated",
    );
  return {
    records,
    capabilities,
    asOf: new Date().toISOString(),
    metadata: {
      transport: "rest",
      sourceAsOfKnown: false,
      completeThrough: null,
      note: "Collection time; upstream record freshness can differ.",
    },
  };
}
export async function oauthStart(
  c: ConnectorConfig,
  secrets: Secrets,
  cfg: Config,
  redirectUri: string,
) {
  await approvedUrl(c.authorizationUrl, cfg);
  const verifier = randomBytes(48).toString("base64url"),
    state = randomBytes(32).toString("hex"),
    url = new URL(c.authorizationUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", secrets.clientId || "");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", c.scope);
  url.searchParams.set("state", state);
  url.searchParams.set(
    "code_challenge",
    createHash("sha256").update(verifier).digest("base64url"),
  );
  url.searchParams.set("code_challenge_method", "S256");
  return { url: url.toString(), verifier, state };
}
export async function oauthFinish(
  c: ConnectorConfig,
  secrets: Secrets,
  cfg: Config,
  code: string,
  verifier: string,
  redirectUri: string,
) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
  });
  const headers = {
    "Content-Type": "application/x-www-form-urlencoded",
    Authorization:
      "Basic " +
      Buffer.from(secrets.clientId + ":" + secrets.clientSecret).toString(
        "base64",
      ),
  };
  const r = await request(c.tokenUrl, cfg, { method: "POST", headers, body });
  const token = JSON.parse(r.text);
  if (!token.access_token)
    throw new ProviderError("OAuth response did not include an access token");
  return {
    ...secrets,
    accessToken: token.access_token,
    refreshToken: token.refresh_token || "",
    expiresAt: String(Date.now() + Number(token.expires_in || 300) * 1000),
  };
}
