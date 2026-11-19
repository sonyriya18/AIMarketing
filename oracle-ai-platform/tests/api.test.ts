// Persistent API integration tests (embedded PGlite by default, or real PostgreSQL as the
// non-owner runtime role when TEST_DATABASE_URL is set). All data is synthetic.
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import request from "supertest";
import { readFileSync } from "node:fs";
import { Database } from "../server/db";
import { config } from "../server/config";
import { createApp } from "../server/app";
import { runDigest } from "../server/routes-workflows";

const cfg = config({
  NODE_ENV: "test",
  DATA_DIR: ".data/tests",
  SESSION_SECRET: "test-session-secret-at-least-32-characters",
  ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
  AI_DAILY_LIMIT: "50",
  // Optional: run this suite against a real, empty PostgreSQL database as the
  // non-owner runtime role (see docs/GO_LIVE_CHECKLIST.md). Embedded PGlite otherwise.
  DATABASE_URL: process.env.TEST_DATABASE_URL || "",
});
const db = new Database(cfg, true),
  app = createApp(db, cfg);
const agents: Record<string, ReturnType<typeof request.agent>> = {};
const csrf: Record<string, string> = {};
const as = (who: string) => {
  const ag = agents[who];
  return {
    get: (u: string) => ag.get("/api" + u),
    post: (u: string, body: unknown = {}) =>
      ag
        .post("/api" + u)
        .set("x-csrf-token", csrf[who])
        .send(body as object),
    put: (u: string, body: unknown = {}) =>
      ag
        .put("/api" + u)
        .set("x-csrf-token", csrf[who])
        .send(body as object),
    patch: (u: string, body: unknown = {}) =>
      ag
        .patch("/api" + u)
        .set("x-csrf-token", csrf[who])
        .send(body as object),
    del: (u: string, body: unknown = {}) =>
      ag
        .delete("/api" + u)
        .set("x-csrf-token", csrf[who])
        .send(body as object),
  };
};
const example = (app: string) => readFileSync(`examples/${app}.json`, "utf8");
const upload = (
  content: string,
  name: string,
  extra: Record<string, unknown> = {},
) => ({
  files: [{ content, format: "json", type: "mixed", name: name + ".json" }],
  name,
  asOf: "2026-10-28T12:00:00Z",
  ...extra,
});
let wsA = "",
  wsB = "",
  eloquaSrc = "",
  eloquaRestricted = "",
  unitySrc = "",
  infinitySrc = "",
  report: any = null;

beforeAll(async () => {
  await db.query("SELECT 1");
  // The first local sign-in becomes the platform provider administrator.
  for (const who of [
    "provider",
    "adminA",
    "adminB",
    "analyst",
    "viewer",
    "approver",
  ]) {
    agents[who] = request.agent(app);
    await agents[who]
      .post("/api/auth/dev-login")
      .send({ email: who + "@example.test" })
      .expect(200);
    csrf[who] = (await agents[who].get("/api/session")).body.csrf;
  }
  // The provider subscribes Company A to Responsys, Eloqua and Unity, and Company B to Infinity.
  wsA = (
    await as("provider")
      .post("/provider/companies", {
        name: "Company A",
        slug: "company-a",
        adminEmail: "adminA@example.test",
        tools: [{ app: "responsys" }, { app: "eloqua" }, { app: "unity" }],
      })
      .expect(201)
  ).body.id;
  wsB = (
    await as("provider")
      .post("/provider/companies", {
        name: "Company B",
        slug: "company-b",
        adminEmail: "adminB@example.test",
        tools: [{ app: "infinity" }],
      })
      .expect(201)
  ).body.id;
  await as("adminA").post("/session/workspace", { id: wsA }).expect(200);
  await as("adminB").post("/session/workspace", { id: wsB }).expect(200);
  const src = async (who: string, body: Record<string, unknown>) =>
    (
      await as(who)
        .post("/sources", {
          timezone: "UTC",
          currency: "USD",
          visibility: "workspace",
          ...body,
        })
        .expect(201)
    ).body.id;
  eloquaSrc = await src("adminA", { app: "eloqua", name: "Eloqua production" });
  eloquaRestricted = await src("adminA", {
    app: "eloqua",
    name: "Eloqua test",
    environment: "test",
    visibility: "restricted",
  });
  unitySrc = await src("adminA", {
    app: "unity",
    name: "Unity production",
    policy: { requiredFields: ["email", "country"] },
  });
  infinitySrc = await src("adminB", {
    app: "infinity",
    name: "Infinity site",
    policy: {
      conversionEvent: "purchase",
      funnelSteps: [
        "view_product",
        "add_to_cart",
        "checkout_start",
        "purchase",
      ],
    },
  });
  await as("adminA")
    .put("/members", {
      email: "analyst@example.test",
      role: "analyst",
      apps: ["eloqua"],
    })
    .expect(200);
  await as("adminA")
    .put("/members", {
      email: "viewer@example.test",
      role: "viewer",
      apps: ["eloqua", "unity"],
    })
    .expect(200);
  await as("adminA")
    .put("/members", {
      email: "approver@example.test",
      role: "analyst",
      apps: ["eloqua"],
      permissions: ["approvals"],
    })
    .expect(200);
  for (const who of ["analyst", "viewer", "approver"])
    await as(who).post("/session/workspace", { id: wsA }).expect(200);
}, 60000);
afterAll(() => db.close());

describe.sequential("Access and entitlements (U1–U3)", () => {
  it("shows each company only its entitled applications; users can be narrower", async () => {
    expect((await as("adminA").get("/session")).body.products.sort()).toEqual([
      "eloqua",
      "responsys",
      "unity",
    ]);
    expect((await as("adminB").get("/session")).body.products).toEqual([
      "infinity",
    ]);
    expect((await as("analyst").get("/session")).body.products).toEqual([
      "eloqua",
    ]);
    expect(
      (await as("analyst").get("/session")).body.workspace.permissions,
    ).toEqual([]);
  });
  it("cannot bypass entitlements through direct API calls", async () => {
    await as("adminA").get("/sources?app=infinity").expect(403);
    await as("adminA")
      .post("/sources", {
        app: "infinity",
        name: "x",
        timezone: "UTC",
        currency: "USD",
        visibility: "workspace",
      })
      .expect(403);
    await as("analyst").get(`/sources/${unitySrc}/datasets`).expect(403);
    await as("adminB").get(`/sources/${eloquaSrc}/datasets`).expect(404);
    await as("adminA").get(`/sources/${infinitySrc}/datasets`).expect(404);
    await as("adminB").post("/session/workspace", { id: wsA }).expect(403);
  });
  it("isolates restricted sources and enforces CSRF and origin", async () => {
    await as("analyst")
      .get(`/sources/${eloquaRestricted}/datasets`)
      .expect(404);
    expect(
      (await as("analyst").get("/sources?app=eloqua")).body.map(
        (s: any) => s.id,
      ),
    ).toEqual([eloquaSrc]);
    await agents.adminA.post("/api/sources").send({}).expect(403);
    await agents.adminA
      .post("/api/sources")
      .set("x-csrf-token", csrf.adminA)
      .set("Origin", "https://evil.example")
      .send({})
      .expect(403);
  });
  it("enforces viewer, analyst and connector-administration permissions on the server", async () => {
    await as("viewer")
      .post(`/sources/${eloquaSrc}/import/commit`, upload("[]", "x"))
      .expect(403);
    await as("analyst")
      .post(`/sources/${eloquaSrc}/connections`, {
        config: {
          baseUrl: "https://login.eloqua.com",
          auth: "eloqua-basic",
          transport: "eloqua-bulk",
          providerContractConfirmed: true,
        },
        secrets: {},
      })
      .expect(403);
    await as("adminA")
      .put("/members", {
        email: "analyst@example.test",
        role: "analyst",
        apps: ["eloqua"],
        permissions: ["connectors"],
      })
      .expect(200);
    const conn = await as("analyst")
      .post(`/sources/${eloquaSrc}/connections`, {
        config: {
          baseUrl: "https://login.eloqua.com",
          auth: "eloqua-basic",
          transport: "eloqua-bulk",
          providerContractConfirmed: true,
        },
        secrets: {
          siteName: "Co",
          username: "u",
          password: "test-only-secret",
        },
      })
      .expect(201);
    const listed = await as("analyst")
      .get(`/sources/${eloquaSrc}/connections`)
      .expect(200);
    expect(JSON.stringify(listed.body)).not.toContain("test-only-secret");
    expect(listed.body[0].verification).toBe("configured");
    await as("analyst")
      .post(`/connections/${conn.body.id}/verification`, {
        level: "production_validated",
        evidence: "x".repeat(30),
      })
      .expect(403);
    await as("adminA")
      .put("/members", {
        email: "analyst@example.test",
        role: "analyst",
        apps: ["eloqua"],
        permissions: [],
      })
      .expect(200);
    await as("analyst").post(`/connections/${conn.body.id}/check`).expect(403);
  });
  it("keeps the Responsys launcher separate and disclosed when unconfigured", async () => {
    const r = await as("adminA").get("/responsys").expect(422);
    expect(r.body.error).toMatch(/Responsys v17 was not found in the platform/);
    await as("analyst").get("/responsys").expect(403);
  });
});

describe.sequential("Imports, reports and persistence (D1, D2, D7)", () => {
  it("returns row/file errors, refuses silent partial imports, and accepts an explicit partial batch", async () => {
    const bad = JSON.stringify([
      {
        type: "campaign_metrics",
        id: "m1",
        campaignId: "C",
        periodStart: "2026-10-05",
        periodEnd: "2026-10-01",
        totalSends: "abc",
      },
    ]);
    const p = await as("analyst")
      .post(`/sources/${eloquaSrc}/import/preview`, upload(bad, "bad"))
      .expect(200);
    expect(p.body.errors[0]).toMatchObject({ row: 1, file: "bad.json" });
    await as("analyst")
      .post(`/sources/${eloquaSrc}/import/commit`, upload(bad, "bad"))
      .expect(422);
    expect(
      (await as("analyst").get(`/sources/${eloquaSrc}/datasets`)).body,
    ).toEqual([]);
    const mixed = JSON.stringify([
      { type: "campaign", id: "C1" },
      { type: "campaign", id: "" },
    ]);
    await as("analyst")
      .post(
        `/sources/${eloquaSrc}/import/commit`,
        upload(mixed, "partial", { acceptPartial: true }),
      )
      .expect(422);
    const ok = await as("analyst")
      .post(
        `/sources/${eloquaSrc}/import/commit`,
        upload(mixed, "partial", {
          acceptPartial: true,
          partialReason: "Synthetic test of quarantine",
        }),
      )
      .expect(201);
    expect(ok.body).toMatchObject({ partial: true, quarantinedRows: 1 });
    const rep = await as("analyst")
      .post(`/sources/${eloquaSrc}/reports`, {})
      .expect(200);
    expect(rep.body.warnings[0]).toMatch(/PARTIAL/);
  });
  it("imports the synthetic Eloqua batch idempotently and produces a sourced assessment", async () => {
    const first = await as("analyst")
      .post(
        `/sources/${eloquaSrc}/import/commit`,
        upload(example("eloqua"), "eloqua-synthetic"),
      )
      .expect(201);
    const again = await as("analyst")
      .post(
        `/sources/${eloquaSrc}/import/commit`,
        upload(example("eloqua"), "eloqua-synthetic"),
      )
      .expect(201);
    expect(again.body).toMatchObject({ id: first.body.id, duplicate: true });
    report = (
      await as("analyst").post(`/sources/${eloquaSrc}/reports`, {}).expect(200)
    ).body;
    expect(report.app).toBe("eloqua");
    expect(report.findings[0].priority.rank).toBe(1);
    expect(report.findings[0].recommendation.automation).toMatch(/[ABC]/);
    expect(report.sourceMetadata.files[0].sha256).toHaveLength(64);
    expect(report.candidates.compare.length).toBe(6);
    // Dashboard: topics, explained sections and charts with data.
    expect(report.groups).toEqual([
      "Campaigns",
      "Leads",
      "Sales",
      "Events",
      "Website",
      "Nurture & assets",
    ]);
    const charts = report.sections.filter((s: any) => s.kind === "chart");
    expect(charts.map((c: any) => c.id)).toEqual(
      expect.arrayContaining([
        "email-trend",
        "leads-trend",
        "won-trend",
        "event-chart",
        "visits-trend",
        "nurture-chart",
      ]),
    );
    expect(report.sections.every((s: any) => s.group && s.about)).toBe(true);
    expect(report.findings.every((f: any) => f.group)).toBe(true);
    // AI insights without a provider: labelled rule-based, never invented numbers.
    const ins = (
      await as("analyst").post(`/reports/${report.id}/insights`, {}).expect(200)
    ).body;
    expect(ins.generator).toBe("rule_based");
    expect(ins.statements.length).toBeGreaterThan(0);
  });
  it("compares campaigns with comparability caveats and refuses entities from another dataset", async () => {
    const c = await as("analyst")
      .post(`/sources/${eloquaSrc}/compare`, {
        keys: ["campaign:C-101", "campaign:C-102"],
      })
      .expect(200);
    expect(c.body.caveats.join(" ")).toMatch(/Objectives differ/);
    await as("analyst")
      .post(`/sources/${eloquaSrc}/compare`, {
        keys: ["campaign:C-101", "campaign:NOPE"],
      })
      .expect(422);
    await as("analyst")
      .post(`/sources/${eloquaSrc}/reports`, {
        selectedIds: ["campaign:FOREIGN"],
      })
      .expect(422);
  });
  it("persists scenarios, saved reports and old versions after a new snapshot activates", async () => {
    const sc = await as("analyst")
      .post(`/reports/${report.id}/scenarios`, {
        delivered: 1000,
        baselineClickRate: 5,
        proposedClickRate: 6,
      })
      .expect(200);
    expect(sc.body.projected.additionalClickers).toBe("10");
    await as("analyst")
      .post(`/reports/${report.id}/scenarios`, {
        delivered: 1000,
        baselineClickRate: 5,
        proposedClickRate: 160,
      })
      .expect(422);
    await as("analyst")
      .post(`/reports/${report.id}/save`, { title: "Weekly review" })
      .expect(200);
    const changed = JSON.parse(example("eloqua")).map((r: any) =>
      r.id === "M-101" ? { ...r, hardBounces: 10, softBounces: 10 } : r,
    );
    await as("analyst")
      .post(
        `/sources/${eloquaSrc}/import/commit`,
        upload(JSON.stringify(changed), "eloqua-synthetic-v2", {
          asOf: "2026-10-29T12:00:00Z",
        }),
      )
      .expect(201);
    const old = await as("analyst").get(`/reports/${report.id}`).expect(200);
    expect(old.body.findings.map((f: any) => f.id)).toContain(
      "bounce_rate:campaign:C-101",
    );
    expect(
      (await as("analyst").get(`/sources/${eloquaSrc}/reports`)).body[0].title,
    ).toBe("Weekly review");
    expect(
      (await as("analyst").get(`/sources/${eloquaSrc}/scenarios`)).body,
    ).toHaveLength(1);
  });
  it("exports with formula-injection protection and an honest print view", async () => {
    const csv = await as("viewer")
      .get(`/reports/${report.id}/export?format=csv`)
      .expect(200);
    expect(csv.text).toContain("kind,id");
    const print = await as("viewer")
      .get(`/reports/${report.id}/export?format=print`)
      .expect(200);
    expect(print.text).toMatch(/browser print view/);
    expect(print.text).toContain("Company A");
  });
});

describe.sequential("Follow-through workflows (section 9)", () => {
  let actionId = "",
    draftId = "",
    invId = "";
  it("tracks an action from a finding to an observed outcome without causal claims", async () => {
    const a = await as("analyst")
      .post(`/sources/${eloquaSrc}/actions`, {
        title: "Fix bounces",
        detail: "List hygiene",
        reportId: report.id,
        findingId: "bounce_rate:campaign:C-101",
      })
      .expect(201);
    actionId = a.body.id;
    const out = await as("analyst")
      .post(`/actions/${actionId}/evaluate`)
      .expect(200);
    expect(out.body.status).toBe("issue_no_longer_observed");
    expect(out.body.metric).toMatchObject({ id: "bounce_rate" });
    expect(out.body.statement).toMatch(/not proof/);
    const list = await as("analyst")
      .get(`/sources/${eloquaSrc}/actions`)
      .expect(200);
    const v = list.body[0].version;
    await as("analyst")
      .patch(`/actions/${actionId}`, {
        state: "resolved",
        version: v,
        completionNotes: "Suppressed bounced contacts",
      })
      .expect(200);
    await as("analyst")
      .patch(`/actions/${actionId}`, { state: "open", version: v })
      .expect(409);
  });
  it("records feedback (dismissal needs a reason) and reports value without invented time savings", async () => {
    await as("analyst")
      .post(`/reports/${report.id}/feedback`, {
        findingId: report.findings[0].id,
        verdict: "dismissed",
      })
      .expect(422);
    await as("analyst")
      .post(`/reports/${report.id}/feedback`, {
        findingId: report.findings[0].id,
        verdict: "useful",
        minutes: 12,
      })
      .expect(201);
    const v = await as("analyst")
      .get(`/sources/${eloquaSrc}/value`)
      .expect(200);
    expect(v.body.timeSaved).toBeNull();
    expect(v.body.issuesNoLongerObserved).toBe(1);
  });
  it("drafts, revises and approves with separation of duties; nothing is published", async () => {
    const d = await as("analyst")
      .post(`/sources/${eloquaSrc}/drafts`, {
        draftType: "campaign_brief",
        reportId: report.id,
        findingId: report.findings[0].id,
        title: "Brief",
        useAI: true,
      })
      .expect(201);
    draftId = d.body.id;
    expect(d.body.generator).toBe("rule_based");
    let draft = (await as("analyst").get(`/sources/${eloquaSrc}/drafts`))
      .body[0];
    expect(draft.content.issue).toContain(report.findings[0].title);
    draft = (
      await as("analyst")
        .patch(`/drafts/${draftId}`, {
          content: { ...draft.content, action: "Edited action" },
          version: draft.version,
        })
        .expect(200)
    ).body;
    draft = (
      await as("analyst")
        .post(`/drafts/${draftId}/status`, {
          status: "in_review",
          version: draft.version,
        })
        .expect(200)
    ).body;
    await as("analyst")
      .post(`/drafts/${draftId}/status`, {
        status: "approved",
        version: draft.version,
      })
      .expect(403);
    const approved = await as("approver")
      .post(`/drafts/${draftId}/status`, {
        status: "approved",
        version: draft.version,
      })
      .expect(200);
    expect(approved.body.note).toMatch(/Nothing was published/);
    expect(
      (await as("analyst").get(`/drafts/${draftId}/revisions`)).body,
    ).toHaveLength(4);
  });
  it("builds an investigation with timeline, lineage and missing evidence, and protects concurrent edits", async () => {
    const i = await as("analyst")
      .post(`/sources/${eloquaSrc}/investigations`, {
        reportId: report.id,
        findingId: "bounce_rate:campaign:C-101",
      })
      .expect(201);
    invId = i.body.id;
    const inv = (
      await as("analyst").get(`/investigations/${invId}`).expect(200)
    ).body;
    expect(inv.timeline.length).toBeGreaterThanOrEqual(2);
    expect(inv.timeline.some((t: any) => t.present === false)).toBe(true);
    expect(inv.lineage.definitionVersion).toMatch(/eloqua-assessment/);
    expect(inv.hypotheses[0].source).toBe("rule");
    await as("analyst")
      .patch(`/investigations/${invId}`, {
        version: inv.version,
        notes: "Checked import log",
      })
      .expect(200);
    await as("analyst")
      .patch(`/investigations/${invId}`, {
        version: inv.version,
        notes: "stale",
      })
      .expect(409);
    expect(
      (await as("analyst").post(`/investigations/${invId}/hypotheses`)).body
        .generator,
    ).toBe("rule_based");
  });
  it("runs scheduled digests that deduplicate, and supports acknowledge and snooze", async () => {
    await as("analyst")
      .put(`/sources/${eloquaSrc}/schedule`, {
        cadence: "weekly",
        enabled: true,
      })
      .expect(200);
    const first = await as("analyst")
      .post(`/sources/${eloquaSrc}/schedule/run`)
      .expect(200);
    const second = await as("analyst")
      .post(`/sources/${eloquaSrc}/schedule/run`)
      .expect(200);
    expect(second.body.added).toBe(0);
    expect(first.body.open).toBe(second.body.open);
    const notes = (
      await as("analyst").get(`/sources/${eloquaSrc}/notifications`)
    ).body;
    expect(notes.filter((n: any) => n.kind === "digest")).toHaveLength(1);
    await as("analyst")
      .post(`/notifications/${notes[0].id}/snooze`, { hours: 24 })
      .expect(200);
    expect(
      (
        await as("analyst").get(`/sources/${eloquaSrc}/notifications`)
      ).body.some((n: any) => n.id === notes[0].id),
    ).toBe(false);
    await as("viewer").post(`/notifications/${notes[0].id}/ack`).expect(403);
  });
});

describe.sequential("Unity and Infinity journeys through the API", () => {
  it("assesses Unity readiness, overlap and typed audience drafts", async () => {
    await as("adminA")
      .post(
        `/sources/${unitySrc}/import/commit`,
        upload(example("unity"), "unity-synthetic"),
      )
      .expect(201);
    const r = (
      await as("adminA")
        .post(`/sources/${unitySrc}/reports`, {
          selectedIds: ["segment:SEG-A", "segment:SEG-B"],
        })
        .expect(200)
    ).body;
    expect(
      r.metrics.find((m: any) => m.id === "overlap_jaccard").value,
    ).not.toBeNull();
    const v = await as("adminA")
      .post(`/sources/${unitySrc}/audience/validate`, {
        definition: {
          match: "all",
          conditions: [{ field: "country", operator: "equals", value: "US" }],
        },
      })
      .expect(200);
    expect(v.body).toMatchObject({ ok: true });
    expect(v.body.preview.basis).toMatch(/Not a native Unity segment count/);
    const bad = await as("adminA")
      .post(`/sources/${unitySrc}/audience/validate`, {
        definition: {
          match: "all",
          conditions: [{ field: "password", operator: "equals", value: "x" }],
        },
      })
      .expect(200);
    expect(bad.body.ok).toBe(false);
    const nl = await as("adminA")
      .post(`/sources/${unitySrc}/audience/validate`, {
        request: "US customers with an email",
      })
      .expect(200);
    expect(nl.body).toMatchObject({ ok: false, generator: "rule_based" });
  });
  it("assesses an Infinity journey with explicit steps, window and identity", async () => {
    await as("adminB")
      .post(
        `/sources/${infinitySrc}/import/commit`,
        upload(example("infinity"), "infinity-synthetic"),
      )
      .expect(201);
    const r = (
      await as("adminB")
        .post(`/sources/${infinitySrc}/reports`, {
          options: {
            steps: ["view_product", "purchase"],
            windowMinutes: 60,
            identity: "session",
          },
        })
        .expect(200)
    ).body;
    expect(r.metrics.find((m: any) => m.id === "step_1").value).not.toBeNull();
    expect(r.thresholds.funnelWindowMinutes).toBe(60);
    await as("adminB")
      .post(`/sources/${infinitySrc}/reports`, {
        options: { steps: ["only-one"] },
      })
      .expect(422);
    await as("adminB")
      .post(`/sources/${infinitySrc}/reports`, { options: { sql: "DROP" } })
      .expect(422);
    const cmp = await as("adminB")
      .post(`/sources/${infinitySrc}/compare`, {
        keys: ["cohort:device=mobile", "cohort:device=desktop"],
      })
      .expect(200);
    expect(cmp.body.rows[0].metric).toMatch(/Sessions/);
  });
});

describe.sequential(
  "Cross-application evidence, AI budget and deletion",
  () => {
    it("joins only through an administrator-approved mapping and reports coverage, not attribution", async () => {
      const m = await as("adminA")
        .post("/cross/mappings", {
          name: "Contact email domain ↔ profile email",
          leftSource: eloquaSrc,
          leftEntity: "contact",
          leftField: "accountId",
          rightSource: unitySrc,
          rightEntity: "profile",
          rightField: "masterId",
          normalization: "exact",
        })
        .expect(201);
      await as("analyst")
        .post("/cross/mappings", {
          name: "x",
          leftSource: eloquaSrc,
          leftEntity: "contact",
          leftField: "id",
          rightSource: unitySrc,
          rightEntity: "profile",
          rightField: "id",
          normalization: "exact",
        })
        .expect(403);
      expect((await as("analyst").get("/cross/mappings")).body).toEqual([]);
      const r = await as("adminA")
        .post(`/cross/mappings/${m.body.id}/assess`)
        .expect(200);
      expect(r.body.joinCoverage).toMatchObject({ matched: 0 });
      expect(r.body.caveats.join(" ")).toMatch(
        /does not prove person-level linkage/,
      );
    });
    it("labels Ask AI fallback honestly and keeps chat history per source", async () => {
      const a = await as("analyst")
        .post(`/reports/${report.id}/chat`, {
          question: "Which campaigns need review?",
        })
        .expect(200);
      expect(a.body.generator).toBe("rule_based");
      expect(
        (await as("analyst").get(`/sources/${eloquaSrc}/chat`)).body,
      ).toHaveLength(1);
      expect(
        (await as("viewer").get(`/sources/${eloquaSrc}/chat`)).body,
      ).toHaveLength(0);
      await as("viewer")
        .post(`/reports/${report.id}/chat`, { question: "x" })
        .expect(403);
    });
    it("deletes a dataset under the retention policy and redacts derived reports", async () => {
      const ds = (
        await as("adminA").get(`/sources/${eloquaSrc}/datasets`)
      ).body.find((d: any) => d.name === "eloqua-synthetic");
      await as("analyst")
        .del(`/datasets/${ds.id}`, { confirm: ds.name })
        .expect(403);
      await as("adminA")
        .del(`/datasets/${ds.id}`, { confirm: "wrong" })
        .expect(422);
      await as("adminA")
        .del(`/datasets/${ds.id}`, { confirm: ds.name })
        .expect(200);
      await as("analyst").get(`/reports/${report.id}`).expect(410);
    });
    it("applies subscription changes immediately (tool removed by the provider)", async () => {
      const subA = [{ app: "responsys" }, { app: "eloqua" }, { app: "unity" }];
      await as("provider")
        .patch(`/provider/companies/${wsA}`, {
          tools: subA.filter((t) => t.app !== "eloqua"),
        })
        .expect(200);
      await as("analyst").get(`/sources/${eloquaSrc}/datasets`).expect(403);
      await as("analyst").get("/sources?app=eloqua").expect(403);
      await as("provider")
        .patch(`/provider/companies/${wsA}`, { tools: subA })
        .expect(200);
      await as("analyst").get("/sources?app=eloqua").expect(200);
    });
    it("scheduler helper refuses unknown sources", async () => {
      await expect(runDigest(db, wsB, "missing", "nobody")).rejects.toThrow();
    });
  },
);

describe.sequential("Client subscriptions (provider-controlled)", () => {
  it("lets only the provider create companies and change subscriptions", async () => {
    expect((await as("provider").get("/session")).body.provider).toBe(true);
    expect((await as("adminA").get("/session")).body.provider).toBe(false);
    await as("adminA")
      .post("/workspaces", { name: "Self", slug: "self-made" })
      .expect(403);
    await as("adminA")
      .post("/provider/companies", {
        name: "X",
        slug: "x-co",
        adminEmail: "adminA@example.test",
      })
      .expect(403);
    await as("adminA").get("/provider/companies").expect(403);
    await as("adminA")
      .patch(`/provider/companies/${wsA}`, { tools: [{ app: "infinity" }] })
      .expect(403);
    // A company administrator's settings save cannot add tools.
    await as("adminA")
      .patch("/settings", {
        name: "Company A",
        entitlements: [{ app: "infinity", enabled: true }],
      })
      .expect(200);
    expect((await as("adminA").get("/session")).body.products).not.toContain(
      "infinity",
    );
    const list = (await as("provider").get("/provider/companies").expect(200))
      .body.companies;
    const a = list.find((c: any) => c.id === wsA);
    expect(
      a.tools
        .filter((t: any) => t.enabled)
        .map((t: any) => t.app)
        .sort(),
    ).toEqual(["eloqua", "responsys", "unity"]);
    expect(a.admins).toEqual(["admina@example.test"]);
    expect(a.member).toBe(false);
  });
  it("shows 1, 2, 3 or 4 tools exactly as subscribed, with dates and suspension", async () => {
    const make = async (slug: string, tools: string[]) =>
      (
        await as("provider")
          .post("/provider/companies", {
            name: slug,
            slug,
            adminEmail: "provider@example.test",
            tools: tools.map((app) => ({ app })),
          })
          .expect(201)
      ).body.id as string;
    const cases: [string, string[]][] = [
      ["one-tool", ["responsys"]],
      ["two-tools", ["eloqua", "unity"]],
      ["three-tools", ["responsys", "eloqua", "infinity"]],
      ["four-tools", ["responsys", "eloqua", "unity", "infinity"]],
    ];
    for (const [slug, tools] of cases) {
      const wid = await make(slug, tools);
      await as("provider").post("/session/workspace", { id: wid }).expect(200);
      expect(
        (await as("provider").get("/session")).body.products.sort(),
      ).toEqual([...tools].sort());
    }
    const four = (await as("provider").get("/session")).body.workspace.id;
    // A tool whose subscription ended is hidden; a suspended company sees no tools.
    await as("provider")
      .patch(`/provider/companies/${four}`, {
        tools: [
          { app: "responsys" },
          { app: "eloqua", endsAt: "2020-01-01" },
          { app: "unity" },
          { app: "infinity", startsAt: "2099-01-01" },
        ],
      })
      .expect(200);
    expect((await as("provider").get("/session")).body.products.sort()).toEqual(
      ["responsys", "unity"],
    );
    await as("provider")
      .patch(`/provider/companies/${four}`, { status: "suspended" })
      .expect(200);
    const suspended = (await as("provider").get("/session")).body;
    expect(suspended.products).toEqual([]);
    expect(suspended.workspace.status).toBe("suspended");
    await as("provider").get("/sources?app=unity").expect(403);
    await as("provider")
      .patch(`/provider/companies/${four}`, {
        tools: [
          { app: "eloqua", startsAt: "2026-02-01", endsAt: "2026-01-01" },
        ],
      })
      .expect(422);
    await as("provider")
      .post("/provider/companies", {
        name: "Dup",
        slug: "one-tool",
        adminEmail: "provider@example.test",
      })
      .expect(409);
  });
});

describe.sequential("AI home page (entitlement-filtered)", () => {
  it("shows only the user's authorized applications and sources, with work-queue counts", async () => {
    const analyst = (await as("analyst").get("/home").expect(200)).body;
    expect(analyst.apps).toEqual(["eloqua"]);
    expect(analyst.sources.map((s: any) => s.id)).toEqual([eloquaSrc]);
    const admin = (await as("adminA").get("/home").expect(200)).body;
    expect(admin.sources.map((s: any) => s.app).sort()).toEqual([
      "eloqua",
      "eloqua",
      "unity",
    ]);
    expect(
      (await as("adminB").get("/home")).body.sources.every(
        (s: any) => s.app === "infinity",
      ),
    ).toBe(true);
    const unity = admin.sources.find((s: any) => s.id === unitySrc);
    expect(unity.assessment.high).toBeGreaterThan(0);
  });
  it("writes a labeled rule-based briefing without AI and routes questions by application", async () => {
    const b = (await as("viewer").post("/home/briefing").expect(200)).body;
    expect(b.generator).toBe("rule_based");
    expect(b.statements.length).toBeGreaterThan(0);
    expect(
      b.findings.every((f: any) => ["Eloqua", "Unity"].includes(f.app)),
    ).toBe(true);
    expect(
      (
        await as("adminA").post("/home/route", {
          question: "Why is this audience not ready for activation?",
        })
      ).body,
    ).toMatchObject({ app: "unity", generator: "rule_based" });
    expect(
      (
        await as("analyst").post("/home/route", {
          question: "Why is this audience not ready?",
        })
      ).body.app,
    ).toBeNull();
  });
});

describe.sequential("One-click sample data", () => {
  it("loads the synthetic sample into a source, activates it and applies sample settings once", async () => {
    const sid = (
      await as("adminA")
        .post("/sources", {
          app: "unity",
          name: "Unity sample",
          timezone: "UTC",
          currency: "USD",
          visibility: "workspace",
        })
        .expect(201)
    ).body.id;
    await as("viewer").post(`/sources/${sid}/examples/load`, {}).expect(403);
    const first = (
      await as("adminA").post(`/sources/${sid}/examples/load`, {}).expect(201)
    ).body;
    expect(first.records).toBeGreaterThan(500);
    expect(first.settings).toEqual({ requiredFields: ["email", "country"] });
    const again = (
      await as("adminA").post(`/sources/${sid}/examples/load`, {}).expect(201)
    ).body;
    expect(again.id).toBe(first.id);
    expect(again.settings).toEqual({});
    const r = (
      await as("adminA").post(`/sources/${sid}/reports`, {}).expect(200)
    ).body;
    expect(r.sections.some((s: any) => s.id === "audience-chart")).toBe(true);
  });
});

describe.sequential(
  "Studio: deep dives, head-to-head, flows and customer profile",
  () => {
    const make = async (app: string, who: "adminA" | "adminB" = "adminA") => {
      const sid = (
        await as(who)
          .post("/sources", {
            app,
            name: app + " studio",
            timezone: "UTC",
            currency: "USD",
            visibility: "workspace",
          })
          .expect(201)
      ).body.id;
      await as(who).post(`/sources/${sid}/examples/load`, {}).expect(201);
      return sid;
    };
    it("computes per-campaign measures, the nurture flow and email previews for Eloqua", async () => {
      const sid = await make("eloqua");
      const s = (
        await as("analyst").post(`/sources/${sid}/studio`, {}).expect(200)
      ).body;
      expect(s.entityLabel).toBe("Campaign");
      const web = s.entities.find((e: any) => e.key === "campaign:C-101");
      // Unique click rate = Σ unique clicks / Σ delivered (never an average of rates).
      expect(web.values.delivered).toBe(4700);
      expect(web.values.clickRate).toBeCloseTo((210 / 4700) * 100, 6);
      expect(web.previews[0].subject).toBe("Join our webinar");
      const nurture = s.entities.find((e: any) => e.flow);
      expect(nurture.flow.nodes.length).toBeGreaterThan(2);
      expect(s.notes.join(" ")).toMatch(/currencies are never mixed/);
      // Another company cannot read this source.
      await as("adminB").post(`/sources/${sid}/studio`, {}).expect(404);
    });
    it("draws the Infinity journey and page flows from events", async () => {
      const sid = await make("infinity", "adminB");
      const s = (
        await as("adminB").post(`/sources/${sid}/studio`, {}).expect(200)
      ).body;
      expect(s.flows[0].id).toBe("journey");
      expect(s.entities.some((e: any) => e.group === "segments")).toBe(true);
      const page = s.entities.find((e: any) => e.flow);
      expect(page.flow.columns).toEqual(["Came from", "This page", "Went to"]);
      await as("adminA").post(`/sources/${sid}/studio`, {}).expect(404);
    });
    it("explains audience readiness and finds one customer profile in Unity (audited)", async () => {
      const sid = await make("unity");
      const s = (
        await as("adminA").post(`/sources/${sid}/studio`, {}).expect(200)
      ).body;
      const aud = s.entities[0];
      expect(aud.values.members).toBeGreaterThan(0);
      expect(aud.flow.links.length).toBeGreaterThan(0);
      expect(s.flows[0].id).toBe("identity");
      const p = (
        await as("adminA")
          .post(`/sources/${sid}/profile`, { query: "M-1" })
          .expect(200)
      ).body;
      expect(p.found).toBe(true);
      expect(p.profile.masterId).toBe("M-1");
      expect(p.profile.fields).not.toHaveProperty("sourceSystem");
      expect(
        (
          await as("adminA")
            .post(`/sources/${sid}/profile`, { query: "nobody@x.test" })
            .expect(200)
        ).body.found,
      ).toBe(false);
      await as("adminB")
        .post(`/sources/${sid}/profile`, { query: "M-1" })
        .expect(404);
      // The analyst is not granted Unity, so cannot look people up.
      await as("analyst")
        .post(`/sources/${sid}/profile`, { query: "M-1" })
        .expect(403);
    });
  },
);
