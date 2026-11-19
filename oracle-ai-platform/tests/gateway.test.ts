// One port for all four tools: requests for responsys.<host>:<port> go to the v17 process
// unchanged; everything else is the platform. Uses a stand-in upstream (not v17) on a free port.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { config } from "../server/config";
import { Database } from "../server/db";
import { createApp } from "../server/app";
import {
  framable,
  explainResponsysExit,
  responsysEnv,
  responsysSetupProblem,
} from "../server/responsys-gateway";

let upstream: Server, port: number, db: Database;
const seen: { method?: string; url?: string; body?: string; host?: string } =
  {};
const base = (internal: number): Record<string, string> => ({
  NODE_ENV: "test",
  DATA_DIR: ".data/tests-gateway",
  PORT: "3006",
  APP_ORIGIN: "http://localhost:3006",
  SESSION_SECRET: "test-session-secret-at-least-32-characters",
  ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64"),
  RESPONSYS_DIR: v17Dir,
  RESPONSYS_INTERNAL_PORT: String(internal),
  RESPONSYS_SSO_SECRET: "gateway-test-sso-secret-0123456789abcdef",
});
const v17Dir = mkdtempSync(join(tmpdir(), "v17-"));
const make = (internal: number) =>
  config({
    NODE_ENV: "test",
    DATA_DIR: ".data/tests-gateway",
    PORT: "3006",
    APP_ORIGIN: "http://localhost:3006",
    SESSION_SECRET: "test-session-secret-at-least-32-characters",
    ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64"),
    RESPONSYS_DIR: mkdtempSync(join(tmpdir(), "v17-")),
    RESPONSYS_INTERNAL_PORT: String(internal),
    RESPONSYS_SSO_SECRET: "gateway-test-sso-secret-0123456789abcdef",
    DATABASE_URL: "",
    AI_API_KEY: "",
  });

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      Object.assign(seen, {
        method: req.method,
        url: req.url,
        body,
        host: req.headers.host,
      });
      res.writeHead(201, { "content-type": "text/plain", "x-v17": "yes" });
      res.end("from v17");
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  port = (upstream.address() as AddressInfo).port;
});
afterAll(async () => {
  upstream.close();
  await db?.close();
});

describe("one-port gateway for Responsys v17", () => {
  it("serves v17 at responsys.localhost:3006 and the platform everywhere else", async () => {
    const cfg = make(port);
    expect(cfg.responsysUrl).toBe("http://responsys.localhost:3006");
    db = new Database(cfg, true);
    const app = createApp(db, cfg);
    const r = await request(app)
      .post("/api/v1/imports?x=1")
      .set("Host", "responsys.localhost:3006")
      .set("Content-Type", "application/json")
      .send({ a: 1 })
      .expect(201);
    expect(r.text).toBe("from v17");
    expect(r.headers["x-v17"]).toBe("yes");
    expect(seen).toMatchObject({
      method: "POST",
      url: "/api/v1/imports?x=1",
      body: '{"a":1}',
      host: "responsys.localhost:3006",
    });
    await request(app)
      .get("/health/live")
      .set("Host", "localhost:3006")
      .expect(200, { status: "ok" });
  });
  it("shows a clear page while v17 is not answering", async () => {
    // A port that was free a moment ago: nothing listens there.
    const probe = http.createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const free = (probe.address() as AddressInfo).port;
    await new Promise((r) => probe.close(r));
    const cfg = make(free);
    const app = createApp(db, cfg);
    const r = await request(app)
      .get("/")
      .set("Host", "responsys.localhost:3006")
      .expect(502);
    expect(r.text).toMatch(/Responsys v17 is not answering yet/);
  });
  it("gives v17 only its sign-in settings, never the platform's database or secrets", () => {
    const cfg = make(port);
    const env = responsysEnv(cfg, {
      PATH: "/bin",
      DATABASE_URL: "postgres://platform",
      AI_API_KEY: "platform-key",
      SESSION_SECRET: "platform-secret",
    });
    expect(env).toMatchObject({
      PATH: "/bin",
      PORT: String(port),
      APP_BASE_URL: "http://responsys.localhost:3006",
      AUTH_MODE: "oidc",
      OIDC_ISSUER_URL: "http://localhost:3006/sso",
      OIDC_CLIENT_ID: "responsys-v17",
      OIDC_CLIENT_SECRET: "gateway-test-sso-secret-0123456789abcdef",
    });
    expect(env).not.toHaveProperty("DATABASE_URL");
    expect(env).not.toHaveProperty("AI_API_KEY");
    expect(env).not.toHaveProperty("SESSION_SECRET");
    expect(env).not.toHaveProperty("GEMINI_API_KEY");
  });
  it("shares one AI key (Gemini or ChatGPT) with v17", () => {
    const gemini = config({
      ...base(port),
      AI_PROVIDER: "gemini",
      AI_MODEL: "gemini-test-model",
      AI_API_KEY: "one-gemini-key-for-all-tools",
    });
    expect(responsysEnv(gemini, {})).toMatchObject({
      AI_PROVIDER: "gemini",
      AI_MODEL: "gemini-test-model",
      GEMINI_API_KEY: "one-gemini-key-for-all-tools",
    });
    const openai = config({
      ...base(port),
      AI_PROVIDER: "openai-compatible",
      AI_MODEL: "chat-model",
      AI_API_KEY: "openai-key",
      AI_BASE_URL: "https://api.openai.com/v1",
    });
    expect(responsysEnv(openai, {})).not.toHaveProperty("GEMINI_API_KEY");
    expect(responsysEnv(openai, {})).toMatchObject({
      AI_PROVIDER: "openai",
      AI_MODEL: "chat-model",
      OPENAI_API_KEY: "openai-key",
      OPENAI_BASE_URL: "https://api.openai.com/v1",
    });
    // "openai" / "chatgpt" need only the key and model.
    const chatgpt = config({
      ...base(port),
      AI_PROVIDER: "chatgpt",
      AI_MODEL: "chat-model",
      AI_API_KEY: "openai-key",
    });
    expect(chatgpt.aiProvider).toBe("openai-compatible");
    expect(chatgpt.aiBase).toBe("https://api.openai.com/v1");
    const off = config({
      ...base(port),
      AI_PROVIDER: "gemini",
      AI_MODEL: "m",
      AI_API_KEY: "k",
      RESPONSYS_SHARE_AI: "false",
    });
    expect(responsysEnv(off, {})).not.toHaveProperty("GEMINI_API_KEY");
  });
});

describe("AI settings never stop the local platform", () => {
  it("starts with AI off when the model or key is empty, and accepts OPENAI_API_KEY", () => {
    const off = config({ ...base(3500), AI_PROVIDER: "openai", AI_MODEL: "m" });
    expect(off.aiProvider).toBe("none");
    const named = config({
      ...base(3500),
      AI_PROVIDER: "openai",
      AI_MODEL: " gpt-test ",
      OPENAI_API_KEY: "sk-test",
    });
    expect(named).toMatchObject({
      aiProvider: "openai-compatible",
      aiModel: "gpt-test",
      aiKey: "sk-test",
    });
    expect(() =>
      config({ ...base(3500), NODE_ENV: "production", AI_PROVIDER: "openai" }),
    ).toThrow();
  });
});

describe("Responsys start-up problems are explained in plain words", () => {
  it("names the missing setup step", () => {
    const dir = mkdtempSync(join(tmpdir(), "v17-"));
    expect(responsysSetupProblem(dir)).toMatch(/was not found/);
    mkdirSync(join(dir, "server"));
    writeFileSync(join(dir, "server", "dev.ts"), "");
    expect(responsysSetupProblem(dir)).toMatch(/not installed yet/);
    mkdirSync(join(dir, "node_modules", "tsx", "dist"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "tsx", "dist", "cli.mjs"), "");
    expect(responsysSetupProblem(dir)).toMatch(/no database settings/);
    writeFileSync(join(dir, ".env.local"), "DATABASE_URL=postgres://x\n");
    expect(responsysSetupProblem(dir)).toBeNull();
  });
  it("turns common failures into one next step", () => {
    expect(
      explainResponsysExit("error: password authentication failed", 3056),
    ).toMatch(/wrong database password/);
    expect(
      explainResponsysExit("Error: connect ECONNREFUSED 127.0.0.1:5432", 3056),
    ).toMatch(/PostgreSQL is not running/);
    expect(explainResponsysExit("listen EADDRINUSE :3056", 3056)).toMatch(
      /Port 3056/,
    );
    expect(explainResponsysExit("boom\nlast line", 3056)).toMatch(
      /stopped: last line/,
    );
  });
});

describe("Responsys reaches the AI service through the same company proxy", () => {
  it("passes the proxy and keeps local sign-in calls direct", () => {
    const env: Record<string, string> = responsysEnv(
      config({ ...base(3500), RESPONSYS_SHARE_AI: "false" }),
      {
        PATH: "/bin",
        HTTPS_PROXY: "http://proxy.example.test:8080",
        NODE_OPTIONS: "--use-system-ca",
        SECRET_THING: "never passed",
      },
    );
    expect(env.HTTPS_PROXY).toBe("http://proxy.example.test:8080");
    expect(env.NODE_USE_ENV_PROXY).toBe("1");
    expect(env.NO_PROXY).toContain("localhost");
    expect(env.NODE_OPTIONS).toBe("--use-system-ca");
    expect(env).not.toHaveProperty("SECRET_THING");
  });
});

describe("a key or model that was not pasted correctly", () => {
  it("turns AI off locally instead of sending a broken request", () => {
    const cfg = config({
      ...base(3500),
      NODE_ENV: "development",
      AI_PROVIDER: "openai",
      AI_MODEL: "\u0016",
      AI_API_KEY: "\u0016",
    });
    expect(cfg.aiProvider).toBe("none");
    expect(cfg.aiKey).toBe("");
  });
});

describe("Responsys inside the platform window", () => {
  it("allows framing only by the platform and keeps v17's sign-in cookie usable there", () => {
    const out = framable(
      {
        "x-frame-options": "SAMEORIGIN",
        "content-security-policy":
          "default-src 'self'; frame-ancestors 'none'; img-src 'self'",
        "set-cookie": ["rci_session=abc; Path=/; HttpOnly; SameSite=Lax"],
      },
      "http://localhost:3006",
    );
    expect(out).not.toHaveProperty("x-frame-options");
    expect(out["content-security-policy"]).toBe(
      "default-src 'self'; img-src 'self'; frame-ancestors http://localhost:3006",
    );
    expect(out["set-cookie"]).toEqual([
      "rci_session=abc; Path=/; HttpOnly; SameSite=None; Secure; Partitioned",
    ]);
  });
});
