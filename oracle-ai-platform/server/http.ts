import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import type { Config } from "./config";
import { approvedHost, resolveEndpoint, HttpError } from "./security";

/**
 * The company proxy to use for this host: HTTPS_PROXY (http:// proxies), unless NO_PROXY lists the
 * host. Office networks often allow internet access only through such a proxy.
 */
export function proxyFor(host: string, env: NodeJS.ProcessEnv = process.env) {
  const raw = (env.HTTPS_PROXY || env.https_proxy || "").trim();
  if (!raw) return null;
  const h = host.toLowerCase();
  const skip = (env.NO_PROXY || env.no_proxy || "")
    .split(",")
    .map((s) =>
      s
        .trim()
        .toLowerCase()
        .replace(/^\*?\./, ""),
    )
    .filter(Boolean);
  if (skip.some((s) => s === "*" || h === s || h.endsWith("." + s)))
    return null;
  try {
    const u = new URL(raw.includes("://") ? raw : "http://" + raw);
    return u.protocol === "http:" ? u : null;
  } catch {
    return null;
  }
}

/** Opens host:443 through the proxy (HTTP CONNECT); TLS still verifies the host's certificate. */
function tunnel(proxy: URL, host: string, signal: AbortSignal) {
  return new Promise<TLSSocket>((resolve, reject) => {
    const headers: Record<string, string> = { host: `${host}:443` };
    if (proxy.username)
      headers["proxy-authorization"] =
        "Basic " +
        Buffer.from(
          decodeURIComponent(proxy.username) +
            ":" +
            decodeURIComponent(proxy.password),
        ).toString("base64");
    const req = httpRequest({
      host: proxy.hostname,
      port: Number(proxy.port) || 80,
      method: "CONNECT",
      path: `${host}:443`,
      headers,
      signal,
    });
    req.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        const e: any = new Error(
          `The company proxy refused the connection (${res.statusCode})`,
        );
        e.code = "PROXY_REFUSED";
        reject(e);
        return;
      }
      const tls = tlsConnect({ socket, servername: host });
      tls.once("secureConnect", () => resolve(tls));
      tls.once("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

/** Resolve once and pin that validated public address to the TLS connection.
 * TLS still verifies the original hostname. Redirects are returned, never followed. */
export async function secureRequest(
  raw: string,
  cfg: Config,
  init: RequestInit = {},
  max = 20_000_000,
) {
  // Through a company proxy the proxy connects to the approved host; otherwise the validated
  // public address is pinned.
  const proxy = proxyFor(new URL(raw).hostname);
  const { url, addresses } = proxy
    ? { url: approvedHost(raw, cfg), addresses: [] as const }
    : await resolveEndpoint(raw, cfg);
  const signal = init.signal || AbortSignal.timeout(30000);
  const socket = proxy ? await tunnel(proxy, url.hostname, signal) : null;
  if (
    init.body != null &&
    typeof init.body !== "string" &&
    !(init.body instanceof URLSearchParams)
  )
    throw Error("Unsupported outbound request body");
  const body = init.body?.toString();
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  if (body) headers["content-length"] = String(Buffer.byteLength(body));
  return new Promise<{ response: Response; text: string }>(
    (resolve, reject) => {
      const req = httpsRequest(
        url,
        {
          method: init.method || "GET",
          headers,
          signal,
          ...(socket
            ? { createConnection: () => socket }
            : {
                lookup: ((_host: any, options: any, callback: any) => {
                  const selected = addresses[0]!;
                  if (options?.all) callback(null, [selected]);
                  else callback(null, selected.address, selected.family);
                }) as any,
              }),
          agent: false,
          rejectUnauthorized: true,
        },
        (res) => {
          let bytes = 0;
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > max) {
              req.destroy(
                new HttpError(
                  422,
                  "Provider response exceeds the configured size limit",
                ),
              );
              return;
            }
            chunks.push(chunk);
          });
          res.on("error", reject);
          res.on("end", () => {
            const h = new Headers();
            for (const [k, v] of Object.entries(res.headers))
              if (v !== undefined)
                h.set(k, Array.isArray(v) ? v.join(", ") : v);
            resolve({
              response: new Response(null, {
                status: res.statusCode || 502,
                headers: h,
              }),
              text: Buffer.concat(chunks).toString("utf8"),
            });
          });
        },
      );
      req.on("error", reject);
      req.end(body);
    },
  );
}
