// Client branding: validation, templates, AI context documents, and how the platform starts the
// supplied Responsys release (prebuilt Windows layout) with the shared ChatGPT settings.
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clientDocuments, parseBrand, templateBrand } from "../server/brand";
import { CLIENT_TEMPLATES, PRODUCT_DOCS } from "../shared/clients";
import { responsysEnv, responsysLayout } from "../server/responsys-gateway";
import { config } from "../server/config";

describe("client branding", () => {
  it("accepts the Endeavour Group – Dan Murphy's template", () => {
    const b = templateBrand("endeavour-danmurphys")!;
    expect(parseBrand(b).displayName).toBe("Endeavour Group – Dan Murphy's");
    expect(b.website).toBe("https://www.danmurphys.com.au/dm/home");
    expect(b.facts?.every((f) => f.source.startsWith("https://"))).toBe(true);
    expect(b.guardrails?.join(" ")).toMatch(/18\+/);
  });
  it("offers only Endeavour Group – Dan Murphy's as a client template", () => {
    expect(CLIENT_TEMPLATES.map((t) => t.key)).toEqual([
      "endeavour-danmurphys",
    ]);
  });
  it("rejects unsafe links, logos and unknown fields", () => {
    expect(() => parseBrand({ website: "http://example.com" })).toThrow(
      /https/,
    );
    expect(() => parseBrand({ website: "javascript:alert(1)" })).toThrow();
    expect(() =>
      parseBrand({ logos: { primary: "data:image/svg+xml;base64,AAAA" } }),
    ).toThrow();
    expect(() =>
      parseBrand({ links: [{ label: "x", url: "https://u:p@example.com" }] }),
    ).toThrow();
    expect(() => parseBrand({ admin: true })).toThrow();
    expect(() => parseBrand({ color: "red" })).toThrow();
    expect(() => templateBrand("unknown")).toThrow(/template/);
  });
  it("turns an empty client address into 'not configured'", () => {
    expect(
      parseBrand({ appLinks: { eloqua: "" } }).appLinks?.eloqua,
    ).toBeUndefined();
  });
  it("gives the AI a business profile and binding marketing rules", () => {
    const docs = clientDocuments(
      "Endeavour Group",
      templateBrand("endeavour-danmurphys"),
    );
    expect(docs.map((d) => d.id)).toEqual(["client-profile", "client-rules"]);
    expect(docs[0].content).toMatch(/not campaign results/);
    expect(docs[1].content).toMatch(/ABAC/);
    expect(clientDocuments("X", {})).toEqual([]);
  });
  it("links every application to Oracle documentation on docs.oracle.com", () => {
    for (const docs of Object.values(PRODUCT_DOCS)) {
      expect(docs.length).toBeGreaterThan(0);
      for (const d of docs)
        expect(d.url).toMatch(
          /^https:\/\/docs\.oracle\.com\/en\/cloud\/saas\//,
        );
    }
  });
});

describe("supplied Responsys release", () => {
  it("runs the prebuilt release with server/index.ts, as its own Start.ps1 does", () => {
    const dir = mkdtempSync(join(tmpdir(), "rs-layout-"));
    mkdirSync(join(dir, "dist"));
    mkdirSync(join(dir, "server"));
    expect(responsysLayout(dir).args).toContain(
      join(dir, "node_modules", "tsx", "dist", "cli.mjs"),
    );
    writeFileSync(join(dir, "dist", "index.html"), "");
    writeFileSync(join(dir, "server", "index.ts"), "");
    const layout = responsysLayout(dir);
    expect(layout.args).toEqual([
      "--use-system-ca",
      "--import",
      "tsx",
      "server/index.ts",
    ]);
    expect(layout.portableDatabase).toBe(false);
  });
  it("shares the ChatGPT model through OPENAI_MODEL and never other platform secrets", () => {
    const cfg = config({
      NODE_ENV: "test",
      DATA_DIR: ".data/tests-brand",
      SESSION_SECRET: "test-session-secret-at-least-32-characters",
      ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64"),
      RESPONSYS_DIR: "off",
      RESPONSYS_SSO_SECRET: "x".repeat(40),
      AI_PROVIDER: "openai",
      AI_MODEL: "example-model",
      AI_API_KEY: "placeholder-key",
    });
    const env: Record<string, string> = responsysEnv(cfg, {
      PATH: "/bin",
      SESSION_SECRET: "never",
      DATABASE_URL: "never",
    });
    expect(env.OPENAI_MODEL).toBe("example-model");
    expect(env.OPENAI_API_KEY).toBe("placeholder-key");
    expect(env.PATH).toBe("/bin");
    expect(JSON.stringify(env)).not.toMatch(/never/);
  });
});
