// Responsys single sign-on contract test. The "Responsys" side below uses openid-client v6
// exactly as the unmodified Responsys server does (discovery with an http issuer in development,
// authorization code + PKCE + state + nonce, ID token claims). All data is synthetic.
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as client from "openid-client";
import { Database } from "../server/db";
import { config } from "../server/config";
import { createApp } from "../server/app";

const RESPONSYS = "http://responsys-v17.example.test";
const SECRET = "test-sso-secret-at-least-thirty-two-characters";
let server: Server, base: string, db: Database;
const cookies: Record<string, string> = {};
const csrf: Record<string, string> = {};

async function call(
  who: string,
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
) {
  const r = await fetch(base + path, {
    method,
    redirect: "manual",
    headers: {
      cookie: cookies[who] || "",
      "content-type": "application/json",
      "x-csrf-token": csrf[who] || "",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = r.headers.get("set-cookie");
  if (set) cookies[who] = set.split(";")[0];
  return r;
}
async function signIn(who: string) {
  await call(who, "/api/auth/dev-login", { email: who + "@example.test" });
  csrf[who] = (await (await call(who, "/api/session")).json()).csrf;
}
// What the unmodified Responsys server does: discovery, then a PKCE authorization request.
async function responsysClient(secret = SECRET) {
  const cfg = await client.discovery(
    new URL(base + "/sso"),
    "responsys-v17",
    secret,
    undefined,
    { execute: [client.allowInsecureRequests] },
  );
  const verifier = client.randomPKCECodeVerifier(),
    state = client.randomState(),
    nonce = client.randomNonce();
  const url = client.buildAuthorizationUrl(cfg, {
    redirect_uri: RESPONSYS + "/api/v1/auth/oidc/callback",
    scope: "openid email profile",
    code_challenge: await client.calculatePKCECodeChallenge(verifier),
    code_challenge_method: "S256",
    state,
    nonce,
  });
  return { cfg, url, verifier, state, nonce };
}
const exchange = (
  c: Awaited<ReturnType<typeof responsysClient>>,
  location: string,
  verifier = c.verifier,
) =>
  client.authorizationCodeGrant(c.cfg, new URL(location), {
    pkceCodeVerifier: verifier,
    expectedState: c.state,
    expectedNonce: c.nonce,
    idTokenExpected: true,
  });

beforeAll(async () => {
  // Reserve a port first so the issuer URL is known before the app is configured.
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise((r) => probe.close(r));
  base = `http://127.0.0.1:${port}`;
  const cfg = config({
    NODE_ENV: "test",
    DATA_DIR: ".data/tests-sso",
    APP_ORIGIN: base,
    SESSION_SECRET: "test-session-secret-at-least-32-characters",
    ENCRYPTION_KEY: Buffer.alloc(32, 2).toString("base64"),
    RESPONSYS_URL: RESPONSYS,
    RESPONSYS_SSO_SECRET: SECRET,
  });
  db = new Database(cfg, true);
  server = createApp(db, cfg).listen(port, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  for (const who of ["provider", "subscribed", "other"]) await signIn(who);
  const make = async (slug: string, admin: string, tools: string[]) => {
    const r = await call("provider", "/api/provider/companies", {
      name: slug,
      slug,
      adminEmail: admin + "@example.test",
      tools: tools.map((app) => ({ app })),
    });
    expect(r.status).toBe(201);
    return (await r.json()).id as string;
  };
  const amil = await make("amil", "subscribed", ["responsys", "infinity"]);
  const jade = await make("jade", "other", ["eloqua", "unity"]);
  await call("subscribed", "/api/session/workspace", { id: amil });
  await call("other", "/api/session/workspace", { id: jade });
});
afterAll(async () => {
  server?.close();
  await db?.close();
});

describe("Responsys single sign-on", () => {
  it("publishes discovery metadata that openid-client accepts", async () => {
    const meta = await (
      await fetch(base + "/sso/.well-known/openid-configuration")
    ).json();
    expect(meta.issuer).toBe(base + "/sso");
    expect(meta.code_challenge_methods_supported).toEqual(["S256"]);
    const jwks = await (await fetch(base + "/sso/jwks")).json();
    expect(jwks.keys[0]).toMatchObject({ kty: "RSA", alg: "RS256" });
    expect(jwks.keys[0].d).toBeUndefined(); // never the private key
  });
  it("launches Responsys through single sign-on for a subscribed company", async () => {
    const launch = await (await call("subscribed", "/api/responsys")).json();
    expect(launch).toEqual({
      url: RESPONSYS + "/api/v1/auth/oidc/login?returnTo=%2F",
      singleSignOn: true,
    });
    const c = await responsysClient();
    const r = await call("subscribed", c.url.pathname + c.url.search);
    expect(r.status).toBe(302);
    const location = r.headers.get("location")!;
    expect(location.startsWith(RESPONSYS + "/api/v1/auth/oidc/callback?")).toBe(
      true,
    );
    const tokens = await exchange(c, location);
    const claims = tokens.claims()!;
    expect(claims.email).toBe("subscribed@example.test");
    expect(claims.iss).toBe(base + "/sso");
    expect(claims.aud).toBe("responsys-v17");
    // Local subjects come from the email, so a reinstalled platform signs in to the same Responsys user.
    expect(claims.sub).toMatch(/^local-[0-9a-f]{40}$/);
    // A code works once.
    await expect(exchange(c, location)).rejects.toThrow();
  });
  it("refuses companies without a Responsys subscription and unregistered addresses", async () => {
    await call("other", "/api/responsys").then((r) =>
      expect(r.status).toBe(403),
    );
    const c = await responsysClient();
    const denied = await call("other", c.url.pathname + c.url.search);
    expect(denied.status).toBe(403);
    expect(await denied.text()).toMatch(/not part of your subscription/);
    const wrong = new URL(c.url);
    wrong.searchParams.set(
      "redirect_uri",
      "https://attacker.example/api/v1/auth/oidc/callback",
    );
    const bad = await call("subscribed", wrong.pathname + wrong.search);
    expect(bad.status).toBe(400);
    expect(bad.headers.get("location")).toBeNull();
  });
  it("sends signed-out users to platform sign-in first", async () => {
    const c = await responsysClient();
    const r = await fetch(base + c.url.pathname + c.url.search, {
      redirect: "manual",
    });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toMatch(/^\/\?next=%2Fsso%2Fauthorize/);
  });
  it("rejects a wrong client secret, a wrong PKCE verifier and a revoked subscription", async () => {
    const wrongSecret = await responsysClient("x".repeat(40));
    const r1 = await call(
      "subscribed",
      wrongSecret.url.pathname + wrongSecret.url.search,
    );
    await expect(
      exchange(wrongSecret, r1.headers.get("location")!),
    ).rejects.toThrow();
    const c = await responsysClient();
    const r2 = await call("subscribed", c.url.pathname + c.url.search);
    await expect(
      exchange(c, r2.headers.get("location")!, client.randomPKCECodeVerifier()),
    ).rejects.toThrow();
    // Subscription removed between authorization and token exchange.
    const c3 = await responsysClient();
    const r3 = await call("subscribed", c3.url.pathname + c3.url.search);
    const list = await (
      await call("provider", "/api/provider/companies")
    ).json();
    const amil = list.companies.find((x: any) => x.slug === "amil");
    await call(
      "provider",
      `/api/provider/companies/${amil.id}`,
      { tools: [{ app: "infinity" }] },
      "PATCH",
    );
    await expect(exchange(c3, r3.headers.get("location")!)).rejects.toThrow();
  });
});
