import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Config } from "./config";
import type { SQL } from "./db";
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = "request_failed",
  ) {
    super(message);
  }
}
export const id = () => randomUUID();
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export function seal(value: unknown, key: Buffer) {
  const iv = randomBytes(12),
    c = createCipheriv("aes-256-gcm", key, iv);
  return [
    iv.toString("base64"),
    Buffer.concat([
      c.update(JSON.stringify(value), "utf8"),
      c.final(),
    ]).toString("base64"),
    c.getAuthTag().toString("base64"),
  ].join(".");
}
export function unseal<T = Record<string, string>>(
  value: string,
  key: Buffer,
): T {
  const [iv, data, tag] = value.split(".");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return JSON.parse(
    Buffer.concat([d.update(Buffer.from(data, "base64")), d.final()]).toString(
      "utf8",
    ),
  );
}
export const safeEqual = (a: string, b: string) =>
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
export async function audit(
  tx: SQL,
  workspace: string,
  user: string | null,
  event: string,
  resource: string | null,
  detail: unknown = {},
) {
  await tx.query(
    "INSERT INTO audit(id,workspace_id,user_id,event,resource_id,detail) VALUES($1,$2,$3,$4,$5,$6)",
    [id(), workspace, user, event, resource, JSON.stringify(detail)],
  );
}
export function safeError(e: unknown) {
  const x = e instanceof Error ? e.message : "Unexpected error";
  return x
    .replace(
      /(Bearer\s+|password[=: ]+|token[=: ]+|key[=: ]+)\S+/gi,
      "$1[redacted]",
    )
    .slice(0, 250);
}
export function privateAddress(address: string) {
  return /^(127\.|10\.|192\.168\.|169\.254\.|0\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|172\.(1[6-9]|2\d|3[01])\.|::1$|::$|f[cd]|fe[89ab]|::ffff:)/i.test(
    address,
  );
}
export async function resolveEndpoint(raw: string, cfg: Config) {
  const url = approvedHost(raw, cfg);
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some((a) => privateAddress(a.address)))
    throw new HttpError(
      422,
      "Endpoint resolves to a restricted address",
      "unsafe_endpoint",
    );
  return { url, addresses };
}
/** An approved HTTPS hostname (no DNS lookup; used when a company proxy connects for us). */
export function approvedHost(raw: string, cfg: Config): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(422, "Invalid source URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !cfg.allowedHosts.includes(url.hostname.toLowerCase()) ||
    isIP(url.hostname)
  )
    throw new HttpError(
      422,
      "Endpoint must be an approved HTTPS hostname",
      "unsafe_endpoint",
    );
  return url;
}
export async function approvedUrl(raw: string, cfg: Config) {
  return (await resolveEndpoint(raw, cfg)).url;
}
export async function boundedResponse(response: Response, max = 20_000_000) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  let size = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      throw new HttpError(
        422,
        "Provider response exceeds the configured size limit",
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
