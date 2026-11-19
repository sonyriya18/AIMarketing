import { describe, it, expect } from "vitest";
import { parseImport, parseBatch, validateRecords } from "../server/imports";
import {
  seal,
  unseal,
  safeEqual,
  privateAddress,
  approvedUrl,
  safeError,
} from "../server/security";
import { csvCell } from "../server/routes-data";
import { config } from "../server/config";
import { PolicySchema } from "../shared/policy";

describe("Import validation (D1/D2)", () => {
  it.each([
    "2026-02-31",
    "03/04/2026",
    "2026-10-28T11:00:00",
    "2026-10-28 11:00",
  ])("rejects an ambiguous or impossible timestamp %s", (activityDate) => {
    const r = validateRecords("eloqua", [
      { id: "a", type: "activity", activityType: "EmailOpen", activityDate },
    ]);
    expect(r.errors).toHaveLength(1);
  });
  it("accepts timezone-qualified timestamps and plain dates", () => {
    expect(
      validateRecords("eloqua", [
        {
          id: "a",
          type: "activity",
          activityType: "EmailOpen",
          activityDate: "2026-10-28T11:00:00-03:00",
        },
      ]).errors,
    ).toHaveLength(0);
    expect(
      validateRecords("eloqua", [
        {
          id: "m",
          type: "campaign_metrics",
          campaignId: "c",
          periodStart: "2026-10-01",
          periodEnd: "2026-10-02",
        },
      ]).errors,
    ).toHaveLength(0);
  });
  it.each([-1, 1.5, "NaN", "ten"])(
    "rejects invalid count %s instead of coercing to zero",
    (totalSends) => {
      expect(
        validateRecords("eloqua", [
          {
            id: "m",
            type: "campaign_metrics",
            campaignId: "c",
            periodStart: "2026-10-01",
            periodEnd: "2026-10-02",
            totalSends,
          },
        ]).errors,
      ).toHaveLength(1);
    },
  );
  it("keeps empty values as null and enforces required fields with row and field detail", () => {
    const r = validateRecords("unity", [
      { id: "p1", type: "profile", sourceSystem: "crm", email: "" },
      { id: "p2", type: "profile" },
    ]);
    expect(r.records[0].email).toBeNull();
    expect(r.errors[0]).toMatchObject({
      row: 2,
      message: "sourceSystem is required for profile",
    });
  });
  it("maps real source columns and rejects duplicate IDs", () => {
    const r = parseImport("unity", {
      content: "Key,System,Master\na,crm,M1\na,web,M2",
      format: "csv",
      type: "profile",
      mapping: { id: "Key", sourceSystem: "System", masterId: "Master" },
    });
    expect(r.records[0].masterId).toBe("M1");
    expect(r.errors[0].row).toBe(2);
  });
  it.each(['"__proto__"', "constructor", "prototype"])(
    "refuses the reserved CSV column %s",
    (column) => {
      expect(() =>
        parseImport("unity", {
          content: `id,type,${column}\na,profile,x`,
          format: "csv",
          type: "profile",
        }),
      ).toThrow(/reserved/);
    },
  );
  it("validates a multi-file batch: cross-file duplicates and referential links", () => {
    const segs = JSON.stringify([
      { id: "S1", type: "segment", membershipComplete: true },
    ]);
    const mem = JSON.stringify([
      { id: "1", type: "membership", segmentId: "S1", memberId: "M1" },
      { id: "2", type: "membership", segmentId: "S9", memberId: "M2" },
    ]);
    const r = parseBatch("unity", [
      { content: segs, format: "json", type: "mixed", name: "segments.json" },
      { content: mem, format: "json", type: "mixed", name: "members.json" },
    ]);
    expect(r.errors.map((e) => e.message).join(" ")).toMatch(
      /Segment S9 is not in this batch/,
    );
    expect(r.errors.find((e) => e.message.includes("S9"))!.file).toBe(
      "members.json",
    );
    expect(r.valid).toBe(2);
    const dup = parseBatch("unity", [
      { content: segs, format: "json", type: "mixed", name: "a.json" },
      { content: segs, format: "json", type: "mixed", name: "b.json" },
    ]);
    expect(dup.errors[0].message).toMatch(/also in a.json/);
  });
  it("refuses an Infinity report row without its manifest in the same batch", () => {
    const r = parseBatch("infinity", [
      {
        content: JSON.stringify([
          {
            type: "report_manifest",
            id: "R1",
            startDate: "2026-10-01",
            endDate: "2026-10-02",
          },
          { type: "report_row", id: "x", reportId: "R2", sessions: 5 },
        ]),
        format: "json",
        type: "mixed",
      },
    ]);
    expect(r.errors[0].message).toMatch(/no manifest/);
  });
  it("rejects unknown policy keys", () => {
    expect(() => PolicySchema.parse({ unknownThreshold: 5 })).toThrow();
    expect(
      PolicySchema.parse({
        requiredFields: ["email"],
        conversionEvent: "purchase",
      }),
    ).toBeTruthy();
  });
});

describe("Security controls (A4)", () => {
  it("encrypts secrets and detects ciphertext tampering", () => {
    const key = Buffer.alloc(32, 9),
      cipher = seal({ password: "private-test-value" }, key);
    expect(cipher).not.toContain("private-test-value");
    expect(unseal(cipher, key)).toEqual({ password: "private-test-value" });
    expect(() => unseal(cipher, Buffer.alloc(32, 8))).toThrow();
    expect(safeEqual("é", "a")).toBe(false);
  });
  it("rejects unsafe outbound destinations before contacting them (SSRF)", async () => {
    const cfg = { allowedHosts: ["public.example"] } as any;
    await expect(approvedUrl("http://public.example/a", cfg)).rejects.toThrow();
    await expect(approvedUrl("https://127.0.0.1", cfg)).rejects.toThrow();
    await expect(
      approvedUrl("https://user:pass@public.example", cfg),
    ).rejects.toThrow();
    await expect(
      approvedUrl("https://unapproved.example", cfg),
    ).rejects.toThrow();
    await expect(
      approvedUrl("https://public.example:8443", cfg),
    ).rejects.toThrow();
    expect(privateAddress("169.254.169.254")).toBe(true);
    expect(privateAddress("10.1.2.3")).toBe(true);
    expect(privateAddress("::ffff:127.0.0.1")).toBe(true);
  });
  it("redacts secrets from error messages", () => {
    expect(
      safeError(new Error("failed with Bearer abc.def password=hunter2")),
    ).not.toMatch(/abc\.def|hunter2/);
  });
  it("neutralizes spreadsheet formula injection in exports", () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe(
      '"\'=HYPERLINK(""http://x"")"',
    );
    expect(csvCell("+1")).toBe('"\'+1"');
    expect(csvCell("normal")).toBe('"normal"');
  });
  it("refuses development authentication and self-asserted identity in production", () => {
    expect(() =>
      config({ NODE_ENV: "production", AUTH_MODE: "dev" }),
    ).toThrow();
    expect(() =>
      config({
        NODE_ENV: "production",
        AUTH_MODE: "oidc",
        DATABASE_URL: "postgres://x",
        SESSION_SECRET: "s".repeat(40),
        ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
        OIDC_ISSUER: "https://idp.example",
        OIDC_CLIENT_ID: "a",
        OIDC_CLIENT_SECRET: "b",
        APP_ORIGIN: "http://insecure.example",
      }),
    ).toThrow(/HTTPS/);
    expect(() =>
      config({
        NODE_ENV: "production",
        AUTH_MODE: "oidc",
        DATABASE_URL: "postgres://x",
        DATABASE_MIGRATION_URL: "postgres://owner",
        SESSION_SECRET: "s".repeat(40),
        ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
        OIDC_ISSUER: "https://idp.example",
        OIDC_CLIENT_ID: "a",
        OIDC_CLIENT_SECRET: "b",
        APP_ORIGIN: "https://app.example",
      }),
    ).toThrow(/migration/i);
  });
});
