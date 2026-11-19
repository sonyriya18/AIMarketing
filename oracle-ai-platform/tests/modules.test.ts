// Deterministic golden fixtures for the Eloqua, Unity and Infinity calculation engines (D3–D6).
// All data here is synthetic.
import { describe, it, expect } from "vitest";
import { assess, MODULES } from "../server/modules";
import { compareOutcome } from "../server/outcomes";
import { funnel } from "../server/modules/infinity";
import {
  discoverFields,
  validateDefinition,
  previewDefinition,
} from "../server/modules/unity";
import {
  sampleSizePerArm,
  sum,
  rate,
  twoProportion,
} from "../server/modules/common";
import type { AppId, RecordData, Source } from "../shared/catalog";

const src = (
  app: AppId,
  policy: Record<string, unknown> = {},
  timezone = "UTC",
): Source => ({
  id: "src-1",
  app,
  name: "Synthetic source",
  timezone,
  currency: "USD",
  policy,
  visibility: "workspace",
});
const meta = (extra: Record<string, unknown> = {}) => ({
  datasetId: "ds-1",
  mode: "upload",
  asOf: "2026-10-28T12:00:00Z",
  ...extra,
});
const m = (r: ReturnType<typeof assess>, id: string) =>
  r.metrics.find((x) => x.id === id);
const fids = (r: ReturnType<typeof assess>) => r.findings.map((f) => f.id);
const row = (
  type: string,
  id: string,
  v: Record<string, unknown>,
): RecordData => ({ type, id, ...v });

describe("Shared calculation rules", () => {
  it("keeps missing values unavailable instead of zero", () => {
    expect(
      sum([row("x", "1", { a: "1" }), row("x", "2", { a: null })], "a"),
    ).toBeNull();
    expect(rate(5, 0)).toBeNull();
    expect(rate(null, 10)).toBeNull();
    expect(rate(0, 10)!.toNumber()).toBe(0);
  });
  it("reports percentage-point change for rates and absolute change for counts", () => {
    const after: any = {
      id: "r2",
      datasetId: "d2",
      definitionVersion: "v1",
      metrics: [
        { id: "rate", value: "7.5" },
        { id: "n", value: "12" },
      ],
      findings: [],
      warnings: [],
      capabilities: [],
    };
    const pp = compareOutcome(
      {
        findingId: null,
        definitionVersion: "v1",
        metric: { id: "rate", value: "5", unit: "percent" },
      },
      after,
    );
    expect(pp.metric).toMatchObject({ changePp: "2.5000" });
    expect(pp.statement).toMatch(/not proof/);
    const cnt = compareOutcome(
      {
        findingId: null,
        definitionVersion: "v0",
        metric: { id: "n", value: "10", unit: "count" },
      },
      after,
    );
    expect(cnt.metric).toMatchObject({ change: "2.0000" });
    expect(cnt.flags.join(" ")).toMatch(/definitions changed/);
  });
  it("computes a documented sample size and a two-proportion test", () => {
    const n = sampleSizePerArm(5, 1);
    expect(n).toBeGreaterThan(8100);
    expect(n).toBeLessThan(8200);
    const t = twoProportion(100, 1000, 100, 1000)!;
    expect(t.pValue).toBeCloseTo(1, 5);
    expect(() => sampleSizePerArm(99.5, 1)).toThrow();
  });
});

describe("Eloqua", () => {
  const camp = (id: string, extra: Record<string, unknown> = {}) =>
    row("campaign", id, {
      name: id,
      objective: "registration",
      campaignType: "simple",
      channel: "email",
      ...extra,
    });
  const metrics = (
    id: string,
    campaignId: string,
    start: string,
    end: string,
    v: Record<string, unknown>,
  ) =>
    row("campaign_metrics", id, {
      campaignId,
      periodStart: start,
      periodEnd: end,
      openBasis: "bot-filtered",
      ...v,
    });
  it("aggregates numerators and denominators instead of averaging campaign percentages", () => {
    const r = assess(
      src("eloqua"),
      [
        camp("A"),
        camp("B"),
        metrics("m1", "A", "2026-09-01", "2026-09-10", {
          totalSends: 100,
          totalDelivered: 100,
          uniqueClicks: 50,
          uniqueOpens: 60,
        }),
        metrics("m2", "B", "2026-09-01", "2026-09-10", {
          totalSends: 900,
          totalDelivered: 900,
          uniqueClicks: 90,
          uniqueOpens: 300,
        }),
      ],
      meta(),
    );
    // (50 + 90) / (100 + 900) = 14%, not the average of 50% and 10% (30%).
    expect(m(r, "unique_click_rate")!.value).toBe("14");
    expect(m(r, "total_sends")!.value).toBe("1000");
  });
  it("derives delivered from bounces only when an administrator approves it", () => {
    const rows = [
      metrics("m1", "A", "2026-09-01", "2026-09-10", {
        totalSends: 100,
        hardBounces: 3,
        softBounces: 2,
        uniqueClicks: 10,
      }),
    ];
    expect(
      m(assess(src("eloqua"), rows, meta()), "delivered")!.value,
    ).toBeNull();
    const approved = m(
      assess(src("eloqua", { deliveryFromBounces: true }), rows, meta()),
      "delivered",
    )!;
    expect(approved.value).toBe("95");
    expect(approved.state).toBe("partial");
  });
  it("withholds totals for overlapping aggregate periods (no double counting)", () => {
    const r = assess(
      src("eloqua"),
      [
        metrics("m1", "A", "2026-09-01", "2026-09-15", {
          totalSends: 100,
          totalDelivered: 100,
        }),
        metrics("m2", "A", "2026-09-10", "2026-09-20", {
          totalSends: 100,
          totalDelivered: 100,
        }),
        metrics("m3", "B", "2026-09-01", "2026-09-10", {
          totalSends: 50,
          totalDelivered: 50,
        }),
      ],
      meta(),
    );
    expect(m(r, "total_sends")!.value).toBe("50");
    expect(r.warnings.join(" ")).toMatch(/Overlapping metric periods/);
  });
  it("separates message-level sends from unique recipients and flags unmatched activity", () => {
    const a = (
      id: string,
      t: string,
      contactId: string | null,
      d = "2026-10-01T10:00:00Z",
      campaignId = "A",
    ) =>
      row("activity", id, {
        activityType: t,
        activityDate: d,
        contactId,
        campaignId,
        isBot: false,
      });
    const r = assess(
      src("eloqua"),
      [
        camp("A"),
        a("1", "EmailSend", "K1"),
        a("2", "EmailSend", "K1"),
        a("3", "EmailSend", "K2"),
        a("4", "EmailOpen", "K1"),
        a("5", "EmailOpen", "K9"),
        a("6", "EmailClickthrough", null),
      ],
      meta(),
    );
    expect(m(r, "activity_messages_sent")!.value).toBe("3");
    expect(m(r, "activity_recipients")!.value).toBe("2");
    expect(m(r, "activity_open_rate")!.value).toBe("50");
    expect(m(r, "unmatched_activity")!.value).toBe("2");
    expect(fids(r)).toContain("unmatched_activity:activities");
  });
  it("treats recent sends as immature (delayed activity)", () => {
    const r = assess(
      src("eloqua"),
      [
        camp("A"),
        metrics("m1", "A", "2026-10-20", "2026-10-27", {
          totalSends: 500,
          totalDelivered: 500,
        }),
      ],
      meta(),
    );
    expect(fids(r)).toContain("immature_activity:recent-sends");
    expect(r.sections!.find((s) => s.id === "campaigns")!.rows![0].status).toBe(
      "Still accruing",
    );
  });
  it("needs linked FormSubmit activity and a mature window for click-to-form; downstream CRM stays unavailable", () => {
    const base = [
      camp("A"),
      row("activity", "s1", {
        activityType: "EmailSend",
        activityDate: "2026-10-01T10:00:00Z",
        contactId: "K1",
        campaignId: "A",
      }),
      row("activity", "c1", {
        activityType: "EmailClickthrough",
        activityDate: "2026-10-01T11:00:00Z",
        contactId: "K1",
        campaignId: "A",
      }),
    ];
    const without = assess(src("eloqua"), base, meta());
    expect(m(without, "click_to_form")!.value).toBeNull();
    expect(m(without, "click_to_form")!.reason).toMatch(/FormSubmit/);
    const withForm = assess(
      src("eloqua"),
      [
        ...base,
        row("activity", "f1", {
          activityType: "FormSubmit",
          activityDate: "2026-10-03T11:00:00Z",
          contactId: "K1",
          campaignId: "A",
        }),
      ],
      meta(),
    );
    expect(m(withForm, "click_to_form")!.value).toBe("100");
    expect(withForm.capabilities!.find((c) => c.id === "sales")!.state).toBe(
      "unavailable",
    );
    expect(withForm.warnings.join(" ")).toMatch(
      /Lead stages, pipeline and revenue are unavailable/,
    );
  });
  it("assesses nurture structure, and progression only from step history", () => {
    const steps = [
      row("step", "S1", {
        campaignId: "N",
        stepType: "segment",
        nextStepIds: "S2",
        isEntry: true,
      }),
      row("step", "S2", {
        campaignId: "N",
        stepType: "email",
        nextStepIds: "",
      }),
      row("step", "S9", {
        campaignId: "N",
        stepType: "email",
        nextStepIds: "S2",
      }),
    ];
    const r = assess(src("eloqua"), steps, meta());
    expect(fids(r)).toEqual(
      expect.arrayContaining(["nurture_dead_end:step:S2"]),
    );
    expect(r.sections!.find((s) => s.id === "nurture")!.subtitle).toMatch(
      /Structure only/,
    );
    expect(r.capabilities!.find((c) => c.id === "history")!.state).toBe(
      "unavailable",
    );
    expect(
      r
        .sections!.find((s) => s.id === "nurture")!
        .rows!.every((x) => x.progression === null),
    ).toBe(true);
  });
  it("does not declare a winner between incomparable campaigns", () => {
    const all = [
      camp("A", { objective: "registration" }),
      camp("B", { objective: "awareness" }),
      metrics("m1", "A", "2026-09-01", "2026-09-10", {
        totalSends: 1000,
        totalDelivered: 1000,
        uniqueClicks: 100,
        uniqueOpens: 300,
      }),
      metrics("m2", "B", "2026-09-01", "2026-09-10", {
        totalSends: 1000,
        totalDelivered: 1000,
        uniqueClicks: 50,
        uniqueOpens: 300,
      }),
    ];
    const c = MODULES.eloqua.compare(
      src("eloqua"),
      all,
      ["campaign:A", "campaign:B"],
      meta(),
    );
    expect(c.caveats.join(" ")).toMatch(/Objectives differ/);
    expect(c.test!.conclusion).toMatch(/No winner declared/);
    const same = MODULES.eloqua.compare(
      src("eloqua"),
      all.map((r) =>
        r.type === "campaign" ? { ...r, objective: "registration" } : r,
      ),
      ["campaign:A", "campaign:B"],
      meta(),
    );
    expect(same.test!.pValue).toBeLessThan(0.05);
  });
  it("requires approved thresholds for exposure flags", () => {
    const sends = Array.from({ length: 5 }, (_, i) =>
      row("activity", "s" + i, {
        activityType: "EmailSend",
        activityDate: `2026-10-2${i}T10:00:00Z`,
        contactId: "K1",
        campaignId: "A",
      }),
    );
    expect(
      m(assess(src("eloqua"), sends, meta()), "exposed_contacts")!.value,
    ).toBeNull();
    expect(
      m(
        assess(
          src("eloqua", { exposureMaxSends: 3, exposureWindowDays: 14 }),
          sends,
          meta(),
        ),
        "exposed_contacts",
      )!.value,
    ).toBe("1");
  });
});

describe("Unity", () => {
  const profile = (
    id: string,
    masterId: string | null,
    v: Record<string, unknown> = {},
  ) =>
    row("profile", id, {
      sourceSystem: "crm",
      masterId,
      updatedAt: "2026-10-20T00:00:00Z",
      ...v,
    });
  it("distinguishes source records from master IDs; unlinked is not a duplicate", () => {
    const r = assess(
      src("unity"),
      [
        profile("1", "M1", { email: "a@x.test" }),
        profile("2", "M1", { email: "a@x.test" }),
        profile("3", null),
        profile("4", "M2", { email: "a@x.test" }),
      ],
      meta(),
    );
    expect(m(r, "source_records")!.value).toBe("4");
    expect(m(r, "masters")!.value).toBe("2");
    expect(m(r, "link_coverage")!.value).toBe("75");
    expect(m(r, "duplicate_candidates")!.value).toBe("1");
    expect(
      r.findings.find((f) => f.id.startsWith("duplicate_candidates"))!.detail,
    ).toMatch(/Nothing is merged/);
  });
  it("never infers consent; separates unknown, expired, denied and granted", () => {
    const recs = [
      profile("1", "M1", { email: "a@x.test" }),
      profile("2", "M2", { email: "b@x.test" }),
      profile("3", "M3", { email: "c@x.test" }),
      profile("4", "M4", { email: "d@x.test" }),
      row("consent", "c1", {
        masterId: "M1",
        channel: "email",
        purpose: "marketing",
        status: "granted",
        effectiveDate: "2026-01-01",
      }),
      row("consent", "c2", {
        masterId: "M2",
        channel: "email",
        purpose: "marketing",
        status: "granted",
        effectiveDate: "2026-01-01",
        expiresAt: "2026-06-01",
      }),
      row("consent", "c3", {
        masterId: "M3",
        channel: "email",
        purpose: "marketing",
        status: "denied",
        effectiveDate: "2026-01-01",
      }),
    ];
    const r = assess(src("unity"), recs, meta());
    expect(r.sections!.find((s) => s.id === "consent")!.rows![0]).toMatchObject(
      { granted: 1, expired: 1, denied: 1, unknown: 1 },
    );
  });
  const segFixture = (completeB = true, snapB = "2026-10-27T00:00:00Z") => [
    row("destination", "D", {
      requiredFields: "email",
      consentChannel: "email",
      consentPurpose: "marketing",
    }),
    row("segment", "A", {
      name: "A",
      destinationId: "D",
      identityLevel: "master",
      membershipComplete: true,
      snapshotAt: "2026-10-27T00:00:00Z",
    }),
    row("segment", "B", {
      name: "B",
      destinationId: "D",
      identityLevel: "master",
      membershipComplete: completeB,
      snapshotAt: snapB,
    }),
    ...["M1", "M2", "M3", "M4"].map((x) =>
      row("membership", "A-" + x, { segmentId: "A", memberId: x }),
    ),
    ...["M3", "M4", "M5"].map((x) =>
      row("membership", "B-" + x, { segmentId: "B", memberId: x }),
    ),
    profile("p1", "M1", { email: "1@x.test" }),
    profile("p3", "M3", { email: "3@x.test" }),
    profile("p5", "M5"),
    row("consent", "k1", {
      masterId: "M1",
      channel: "email",
      purpose: "marketing",
      status: "granted",
    }),
    row("consent", "k3", {
      masterId: "M3",
      channel: "email",
      purpose: "marketing",
      status: "granted",
    }),
  ];
  it("reports exact overlap with all four definitions only for complete, compatible memberships", () => {
    const r = assess(src("unity"), segFixture(), meta(), [
      "segment:A",
      "segment:B",
    ]);
    expect(m(r, "overlap_intersection")!.value).toBe("2");
    expect(m(r, "overlap_of_a")!.value).toBe("50");
    expect(m(r, "overlap_of_b")!.value).toBe("66.6667");
    expect(m(r, "overlap_jaccard")!.value).toBe("40");
    const partial = assess(src("unity"), segFixture(false), meta(), [
      "segment:A",
      "segment:B",
    ]);
    expect(m(partial, "overlap_jaccard")!.value).toBeNull();
    expect(m(partial, "overlap_jaccard")!.reason).toMatch(/complete exports/);
    const stale = assess(
      src("unity"),
      segFixture(true, "2026-10-20T00:00:00Z"),
      meta(),
      ["segment:A", "segment:B"],
    );
    expect(m(stale, "overlap_jaccard")!.reason).toMatch(
      /Snapshots are more than/,
    );
  });
  it("computes readiness from record-level blockers and marks incomplete memberships partial", () => {
    const r = assess(src("unity"), segFixture(), meta(), ["segment:A"]);
    // A = M1 (ready), M2 (no profile, no consent), M3 (ready), M4 (no profile, no consent)
    expect(m(r, "ready_members")!.value).toBe("2");
    expect(m(r, "blocked_both")!.value).toBe("2");
    const partial = assess(src("unity"), segFixture(false), meta(), [
      "segment:B",
    ]);
    expect(m(partial, "ready_members")!.state).toBe("partial");
  });
  it("does not claim readiness without destination requirements", () => {
    const r = assess(
      src("unity"),
      [
        row("segment", "A", { membershipComplete: true }),
        row("membership", "1", { segmentId: "A", memberId: "M1" }),
      ],
      meta(),
      ["segment:A"],
    );
    expect(m(r, "ready_members")).toBeUndefined();
    expect(r.warnings.join(" ")).toMatch(/readiness cannot be assessed/);
  });
  it("simulates readiness without double counting members blocked twice", () => {
    const s = MODULES.unity.simulate({
      readyMembers: 10,
      blockedFieldOnly: 10,
      blockedConsentOnly: 10,
      blockedBoth: 10,
      fieldFixRate: 50,
      consentVerifiedRate: 50,
    });
    // 10 + 5 + 5 + 10 × 0.25 = 22.5 → 22 (whole members)
    expect(s.projected.readyMembers).toBe("22");
    expect(s.note).toMatch(/assumed consent is not consent/);
  });
  it("validates typed audience definitions against discovered fields only", () => {
    const profiles = [
      profile("1", "M1", { country: "US", score: "10", joined: "2026-01-01" }),
      profile("2", "M2", { country: "BR", score: "3", joined: "2026-05-01" }),
    ];
    const fields = discoverFields(profiles);
    expect(fields.score).toBe("number");
    expect(() =>
      validateDefinition(
        {
          match: "all",
          conditions: [{ field: "ssn", operator: "equals", value: "x" }],
        },
        fields,
      ),
    ).toThrow(/does not exist/);
    expect(() =>
      validateDefinition(
        {
          match: "all",
          conditions: [{ field: "country", operator: "gt", value: 1 }],
        },
        fields,
      ),
    ).toThrow(/numeric/);
    expect(() =>
      validateDefinition(
        {
          match: "all",
          conditions: [{ field: "country", operator: "drop table", value: 1 }],
        },
        fields,
      ),
    ).toThrow(/not allowed/);
    const d = validateDefinition(
      {
        match: "all",
        conditions: [
          { field: "country", operator: "equals", value: "us" },
          { field: "score", operator: "gte", value: 5 },
        ],
      },
      fields,
    );
    expect(previewDefinition(d, profiles).count).toBe(1);
  });
  it("marks stale records using the approved window", () => {
    const r = assess(
      src("unity", { staleDays: 10 }),
      [
        profile("1", "M1", { updatedAt: "2026-10-01T00:00:00Z" }),
        profile("2", "M2"),
      ],
      meta(),
    );
    expect(m(r, "stale_records")!.value).toBe("1");
  });
});

describe("Infinity", () => {
  const ev = (
    id: string,
    event: string,
    ts: string,
    sessionId: string,
    extra: Record<string, unknown> = {},
  ) => row("event", id, { event, timestamp: ts, sessionId, ...extra });
  it("counts ordered steps within the window, regardless of arrival order and repeats", () => {
    const events = [
      ev("3", "checkout", "2026-10-01T10:05:00Z", "S1"),
      ev("1", "view", "2026-10-01T10:00:00Z", "S1"),
      ev("2", "cart", "2026-10-01T10:02:00Z", "S1"),
      ev("2b", "cart", "2026-10-01T10:03:00Z", "S1"),
      ev("4", "view", "2026-10-01T10:00:00Z", "S2"),
      ev("5", "cart", "2026-10-01T11:30:00Z", "S2"), // outside 30-minute window
      ev("6", "cart", "2026-10-01T10:00:00Z", "S3"),
      ev("7", "view", "2026-10-01T10:01:00Z", "S3"), // wrong order
    ];
    expect(
      funnel(events, ["view", "cart", "checkout"], 30, "session").reached,
    ).toEqual([3, 1, 1]);
    // Cross-session progression needs visitor identity.
    const cross = [
      ev("a", "view", "2026-10-01T10:00:00Z", "S1", { visitorId: "V" }),
      ev("b", "cart", "2026-10-01T10:10:00Z", "S2", { visitorId: "V" }),
    ];
    expect(funnel(cross, ["view", "cart"], 30, "session").reached).toEqual([
      1, 0,
    ]);
    expect(funnel(cross, ["view", "cart"], 30, "visitor").reached).toEqual([
      1, 1,
    ]);
  });
  it("cannot build a funnel from report totals", () => {
    const r = assess(
      src("infinity", { funnelSteps: ["a", "b"] }),
      [
        row("report_manifest", "R", {
          startDate: "2026-10-01",
          endDate: "2026-10-02",
          rowsDisjoint: true,
        }),
        row("report_row", "1", {
          reportId: "R",
          date: "2026-10-01",
          sessions: "10",
        }),
      ],
      meta(),
    );
    expect(r.metrics.some((x) => x.id.startsWith("step_"))).toBe(false);
    expect(r.capabilities!.find((c) => c.id === "journey")!.state).toBe(
      "unavailable",
    );
  });
  it("never sums visitors across rows and never adds subtotals to detail rows", () => {
    const manifest = row("report_manifest", "R", {
      startDate: "2026-10-01",
      endDate: "2026-10-02",
      rowsDisjoint: false,
    });
    const r = assess(
      src("infinity"),
      [
        manifest,
        row("report_row", "t1", {
          reportId: "R",
          date: "2026-10-01",
          isTotal: true,
          sessions: "100",
          visitors: "80",
          convertedSessions: "5",
        }),
        row("report_row", "t2", {
          reportId: "R",
          date: "2026-10-02",
          isTotal: true,
          sessions: "50",
          visitors: "45",
          convertedSessions: "5",
        }),
        row("report_row", "d1", {
          reportId: "R",
          date: "2026-10-01",
          dimension: "device",
          dimensionValue: "mobile",
          sessions: "60",
          convertedSessions: "2",
        }),
      ],
      meta(),
    );
    expect(m(r, "report_sessions")!.value).toBe("150");
    expect(m(r, "report_visitors")!.value).toBeNull();
    expect(m(r, "report_conversion_rate")!.value).toBe("6.6667");
    const noTotals = assess(
      src("infinity"),
      [
        manifest,
        row("report_row", "d1", {
          reportId: "R",
          dimension: "device",
          dimensionValue: "mobile",
          sessions: "60",
        }),
        row("report_row", "d2", {
          reportId: "R",
          dimension: "channel",
          dimensionValue: "email",
          sessions: "30",
        }),
      ],
      meta(),
    );
    expect(m(noTotals, "report_sessions")!.value).toBeNull();
  });
  it("counts a session once however many conversion events it has", () => {
    const r = assess(
      src("infinity", { conversionEvent: "buy" }),
      [
        ev("1", "view", "2026-10-01T10:00:00Z", "S1"),
        ev("2", "buy", "2026-10-01T10:01:00Z", "S1"),
        ev("3", "buy", "2026-10-01T10:02:00Z", "S1"),
        ev("4", "view", "2026-10-01T10:00:00Z", "S2"),
      ],
      meta(),
    );
    expect(m(r, "conversion_events")!.value).toBe("2");
    expect(m(r, "converted_sessions")!.value).toBe("1");
    expect(m(r, "event_conversion_rate")!.value).toBe("50");
  });
  it("reports insufficient history instead of an invented anomaly", () => {
    const r = assess(
      src("infinity"),
      [
        ev("1", "view", "2026-10-25T10:00:00Z", "S1"),
        ev("2", "view", "2026-10-26T10:00:00Z", "S2"),
        ev("3", "view", "2026-10-27T10:00:00Z", "S3"),
      ],
      meta(),
    );
    expect(m(r, "daily_events")!.value).toBeNull();
    expect(m(r, "daily_events")!.reason).toMatch(/Insufficient history/);
  });
  it("uses the source timezone for period boundaries", () => {
    // 02:00 UTC on 1 Oct is still 30 Sep in New York.
    const events = [
      ev("1", "view", "2026-10-01T02:00:00Z", "S1"),
      ev("2", "view", "2026-10-01T15:00:00Z", "S2"),
    ];
    const ny = assess(
      src("infinity", {}, "America/New_York"),
      events,
      meta({ periodStart: "2026-10-01", periodEnd: "2026-10-01" }),
    );
    expect(m(ny, "event_sessions")!.value).toBe("1");
    const utc = assess(
      src("infinity"),
      events,
      meta({ periodStart: "2026-10-01", periodEnd: "2026-10-01" }),
    );
    expect(m(utc, "event_sessions")!.value).toBe("2");
  });
  it("flags tracking quality against the specification, including late and duplicate events", () => {
    const r = assess(
      src("infinity", { lateMinutes: 30 }),
      [
        row("tracking_spec", "view", { requiredAttributes: "page" }),
        ev("1", "view", "2026-10-01T10:00:00Z", "S1", {
          page: "/a",
          receivedAt: "2026-10-01T10:00:05Z",
        }),
        ev("2", "view", "2026-10-01T10:00:00Z", "S1", {
          page: "/a",
          receivedAt: "2026-10-01T12:00:00Z",
        }),
        ev("3", "view", "2026-10-01T11:00:00Z", "S2", {
          receivedAt: "2026-10-01T11:00:01Z",
        }),
        ev("4", "promo", "2026-10-01T11:00:00Z", "S2", {
          receivedAt: "2026-10-01T11:00:01Z",
        }),
      ],
      meta(),
    );
    expect(m(r, "late_events")!.value).toBe("1");
    expect(m(r, "duplicate_event_candidates")!.value).toBe("1");
    expect(m(r, "tracking_issues")!.value).toBe("2");
  });
  it("labels conversion scenarios as hypothetical and requires a currency for value", () => {
    expect(() =>
      MODULES.infinity.simulate({
        sessions: 1000,
        baselineRate: 2,
        proposedRate: 3,
        valuePerConversion: 10,
      }),
    ).toThrow(/currency/);
    const s = MODULES.infinity.simulate({
      sessions: 1000,
      baselineRate: 2,
      proposedRate: 3,
      valuePerConversion: 10,
      currency: "brl",
    });
    expect(s.projected).toMatchObject({
      additionalConvertedSessions: "10",
      hypotheticalValue: "100",
    });
    expect(s.note).toMatch(/Hypothetical/);
  });
});

describe("Eloqua leads, sales, events and website", () => {
  const lead = (id: string, created: string, v: Record<string, unknown> = {}) =>
    row("lead", id, { createdAt: created, stage: "Lead", ...v });
  it("computes stage conversion only on mature leads, from milestone dates", () => {
    const leads = [
      lead("L1", "2026-08-01T00:00:00Z", {
        mqlAt: "2026-08-03T00:00:00Z",
        salAt: "2026-08-05T00:00:00Z",
        leadSource: "Webinar",
      }),
      lead("L2", "2026-08-02T00:00:00Z", {
        mqlAt: "2026-08-04T00:00:00Z",
        leadSource: "Webinar",
      }),
      lead("L3", "2026-08-03T00:00:00Z", { leadSource: "Search" }),
      lead("L4", "2026-08-04T00:00:00Z", {
        mqlAt: "2026-08-06T00:00:00Z",
        disqualifiedAt: "2026-08-08T00:00:00Z",
      }),
      // Too young to judge: excluded from rates, still counted as created.
      lead("L5", "2026-10-20T00:00:00Z", { mqlAt: "2026-10-21T00:00:00Z" }),
    ];
    const r = assess(
      src("eloqua", {
        minCohort: 1,
        staleLeadDays: 14,
        mqlAcceptanceThreshold: 50,
      }),
      leads,
      meta(),
    );
    expect(m(r, "leads_created")!.value).toBe("5");
    expect(m(r, "lead_to_mql")!.value).toBe("75"); // 3 of 4 mature
    expect(m(r, "mql_to_sal")!.value).toBe("33.3333"); // 1 of 3 mature MQLs
    expect(m(r, "sal_to_sql")!.value).toBeNull(); // no sqlAt in the export: unavailable, not zero
    expect(m(r, "sal_to_sql")!.reason).toMatch(/no sqlAt/);
    expect(m(r, "mql_to_sal_days")!.value).toBe("2");
    // L2 waits since Aug 4 (L4 is disqualified, L5 is recent).
    expect(m(r, "stalled_mqls")!.value).toBe("1");
    expect(fids(r)).toContain("stalled_mqls:stalled_mqls");
    expect(fids(r)).toContain("low_mql_acceptance:mql_acceptance");
    expect(r.warnings.join(" ")).toMatch(/1 leads were created within 30 days/);
  });
  it("keeps currencies apart and measures pipeline, win rate and cycle", () => {
    const opps = [
      row("opportunity", "O1", {
        createdAt: "2026-09-01T00:00:00Z",
        closedAt: "2026-09-21T00:00:00Z",
        outcome: "won",
        amount: "1000",
        currency: "USD",
        campaignId: "A",
      }),
      row("opportunity", "O2", {
        createdAt: "2026-09-02T00:00:00Z",
        closedAt: "2026-09-12T00:00:00Z",
        outcome: "lost",
        amount: "500",
        campaignId: "A",
      }),
      row("opportunity", "O3", {
        createdAt: "2026-06-01T00:00:00Z",
        outcome: "open",
        amount: "2000",
      }),
      row("opportunity", "O4", {
        createdAt: "2026-10-01T00:00:00Z",
        outcome: "open",
        amount: "900",
        currency: "EUR",
      }),
    ];
    const r = assess(src("eloqua", { staleOpportunityDays: 90 }), opps, meta());
    expect(m(r, "won_revenue")!.value).toBe("1000");
    expect(m(r, "win_rate")!.value).toBe("50");
    expect(m(r, "open_pipeline")!.value).toBe("2000");
    expect(m(r, "open_pipeline")!.state).toBe("partial");
    expect(m(r, "sales_cycle_days")!.value).toBe("20");
    expect(r.warnings.join(" ")).toMatch(/currency other than USD/);
    expect(fids(r)).toContain("aging_pipeline:aging_pipeline");
    const table = r.sections!.find((s) => s.id === "campaign-revenue")!;
    expect(table.rows![0]).toMatchObject({
      campaign: "A",
      opps: 2,
      won: "1000",
    });
  });
  it("measures event attendance only for held events and flags low attendance", () => {
    const recs: RecordData[] = [
      row("marketing_event", "E1", {
        name: "Webinar",
        startsAt: "2026-10-01T15:00:00Z",
      }),
      row("marketing_event", "E2", {
        name: "Future",
        startsAt: "2026-12-01T15:00:00Z",
      }),
      ...Array.from({ length: 10 }, (_, i) =>
        row("event_registrant", "R" + i, {
          eventId: "E1",
          registeredAt: "2026-09-20T00:00:00Z",
          contactId: "K" + i,
          attended: i < 3,
          cancelled: i === 9,
        }),
      ),
      row("event_registrant", "F1", {
        eventId: "E2",
        registeredAt: "2026-10-20T00:00:00Z",
      }),
      row("opportunity", "O1", {
        createdAt: "2026-10-10T00:00:00Z",
        outcome: "open",
        contactId: "K1",
        amount: "100",
      }),
    ];
    const r = assess(
      src("eloqua", { minCohort: 5, eventAttendanceThreshold: 40 }),
      recs,
      meta(),
    );
    expect(m(r, "event_registrations")!.value).toBe("10"); // 9 + 1, cancelled excluded
    expect(m(r, "event_attendance_rate")!.value).toBe("33.3333"); // 3 of 9, upcoming excluded
    expect(m(r, "event_attendee_opportunities")!.value).toBe("1");
    expect(fids(r)).toContain("event_low_attendance:marketing_event:E1");
    const ev = r.sections!.find((s) => s.id === "events")!;
    expect(ev.rows!.find((x) => x.key === "event:E2")).toMatchObject({
      status: "Upcoming",
      attendance: null,
    });
  });
  it("reports website visits without inventing missing durations", () => {
    const visits = Array.from({ length: 12 }, (_, i) =>
      row("site_visit", "V" + i, {
        visitedAt: "2026-10-10T10:00:00Z",
        firstPageUrl: i < 6 ? "/blog" : "/pricing",
        pages: i < 6 ? 1 : 3,
        ...(i === 11 ? {} : { durationSeconds: i < 6 ? 4 : 120 }),
        ...(i === 0 ? { contactId: "K1" } : {}),
      }),
    );
    const r = assess(
      src("eloqua", {
        minCohort: 5,
        knownVisitorThreshold: 10,
        shortVisitSeconds: 10,
      }),
      visits,
      meta(),
    );
    expect(m(r, "web_visits")!.value).toBe("12");
    expect(m(r, "web_known_visitor_share")!.value).toBe("8.3333");
    expect(m(r, "web_pages_per_visit")!.value).toBe("2");
    expect(m(r, "web_median_visit_seconds")!.state).toBe("partial");
    expect(fids(r)).toContain("website_low_known:website");
    expect(fids(r)).toContain("landing_short_visits:page:/blog");
    expect(fids(r)).not.toContain("landing_short_visits:page:/pricing");
  });
  it("projects pipeline only from entered assumptions", () => {
    const s = MODULES.eloqua.simulate({
      delivered: "10000",
      baselineClickRate: "2",
      proposedClickRate: "3",
      clickToFormRate: "10",
      formToOpportunityRate: "20",
      winRate: "50",
      avgDeal: "1000",
      currency: "USD",
    });
    expect(s.projected).toMatchObject({
      additionalClickers: "100",
      additionalFormSubmitters: "10",
      additionalOpportunities: "2",
      additionalWins: "1",
      hypotheticalRevenue: "1000",
    });
    expect(() =>
      MODULES.eloqua.simulate({
        delivered: "1",
        baselineClickRate: "1",
        proposedClickRate: "2",
        winRate: "5",
      }),
    ).toThrow(/click-to-form/);
  });
});

describe("Infinity website performance and time spent", () => {
  const ev = (
    id: string,
    session: string,
    at: string,
    page: string,
    v: Record<string, unknown> = {},
  ) =>
    row("event", id, {
      event: "page_view",
      timestamp: at,
      sessionId: session,
      page,
      ...v,
    });
  it("times pages to the next view, leaves exits untimed and single hits unmeasured", () => {
    const recs = [
      ev("1", "S1", "2026-10-10T10:00:00Z", "/home", { device: "mobile" }),
      ev("2", "S1", "2026-10-10T10:00:30Z", "/product", { device: "mobile" }),
      ev("3", "S1", "2026-10-10T10:02:30Z", "/checkout", { device: "mobile" }),
      ev("4", "S2", "2026-10-10T11:00:00Z", "/home", { device: "desktop" }),
      ev("5", "S3", "2026-10-10T12:00:00Z", "/home", { device: "desktop" }),
      ev("6", "S3", "2026-10-10T12:00:10Z", "/home", { device: "desktop" }), // same page: one view
    ];
    const r = assess(src("infinity", { minCohort: 1 }), recs, meta());
    expect(m(r, "web_page_views")!.value).toBe("5");
    expect(m(r, "web_single_page_rate")!.value).toBe("66.6667"); // S2 and S3 viewed one page
    expect(m(r, "web_avg_time_on_page_seconds")!.value).toBe("75"); // (30 + 120) / 2
    expect(m(r, "web_time_measured_share")!.value).toBe("40");
    expect(m(r, "web_median_session_seconds")!.value).toBe("80"); // median(150, 10); S2 unmeasurable
    expect(m(r, "web_median_session_seconds")!.state).toBe("partial");
    const pages = r.sections!.find((s) => s.id === "web-pages")!;
    expect(pages.rows!.find((x) => x.page === "/home")).toMatchObject({
      views: 3,
      entries: 3,
      single: "66.6667",
      time: "30",
    });
    const bars = r.sections!.find((s) => s.id === "web-time")!.chart!.data;
    expect(bars.find((b) => b.band === "10–30 s")!.sessions).toBe(1);
    expect(bars.find((b) => b.band === "1–3 min")!.sessions).toBe(1);
  });
  it("sums saved page report counters and never averages row percentages", () => {
    const pm = (
      id: string,
      page: string,
      device: string,
      v: Record<string, unknown>,
    ) =>
      row("page_metrics", id, {
        page,
        device,
        periodStart: "2026-10-01",
        periodEnd: "2026-10-27",
        ...v,
      });
    const recs = [
      pm("a", "/blog", "mobile", {
        pageViews: 100,
        entries: 80,
        exits: 90,
        bounces: 72,
        timeOnPageSeconds: 300,
        timedPageViews: 50,
      }),
      pm("b", "/blog", "desktop", {
        pageViews: 20,
        entries: 20,
        exits: 10,
        bounces: 4,
        timeOnPageSeconds: 600,
        timedPageViews: 10,
      }),
    ];
    const r = assess(
      src("infinity", {
        minCohort: 5,
        webBounceThreshold: 60,
        lowTimeOnPageSeconds: 20,
        exitRateThreshold: 60,
      }),
      recs,
      meta(),
    );
    expect(m(r, "web_report_page_views")!.value).toBe("120");
    expect(m(r, "web_report_bounce_rate")!.value).toBe("76"); // 76 / 100, not mean(90%, 20%)
    expect(m(r, "web_report_avg_time_seconds")!.value).toBe("15"); // 900 / 60
    expect(fids(r)).toEqual(
      expect.arrayContaining([
        "web_high_bounce:report-page:/blog",
        "web_low_time:report-page:/blog",
        "web_high_exit:report-page:/blog",
      ]),
    );
    // Overlapping rows for the same page and device are withheld.
    const overlap = assess(
      src("infinity"),
      [
        ...recs,
        pm("c", "/blog", "mobile", { pageViews: 5, periodStart: "2026-10-20" }),
      ],
      meta(),
    );
    expect(m(overlap, "web_report_page_views")!.value).toBeNull();
    expect(overlap.warnings.join(" ")).toMatch(/Overlapping report periods/);
  });
  it("flags a device gap only when the test and cohort rules agree", () => {
    const recs: RecordData[] = [];
    for (let i = 0; i < 60; i++) {
      const device = i < 30 ? "mobile" : "desktop";
      recs.push(
        ev("a" + i, "S" + i, "2026-10-10T10:00:00Z", "/home", { device }),
      );
      if (device === "desktop" || i < 6)
        recs.push(
          ev("b" + i, "S" + i, "2026-10-10T10:01:00Z", "/next", { device }),
        );
    }
    const r = assess(src("infinity", { minCohort: 20 }), recs, meta());
    expect(fids(r)).toContain("web_device_gap:device:mobile");
  });
});

describe("Dashboard charts", () => {
  it("draws monthly trends from summed numerators and denominators, never averaged rates", () => {
    const rows = [
      row("campaign_metrics", "a", {
        campaignId: "A",
        periodStart: "2026-08-01",
        periodEnd: "2026-08-31",
        totalSends: 1000,
        totalDelivered: 1000,
        uniqueOpens: 100,
        uniqueClicks: 10,
      }),
      row("campaign_metrics", "b", {
        campaignId: "B",
        periodStart: "2026-08-01",
        periodEnd: "2026-08-31",
        totalSends: 100,
        totalDelivered: 100,
        uniqueOpens: 90,
        uniqueClicks: 9,
      }),
      row("campaign_metrics", "c", {
        campaignId: "A",
        periodStart: "2026-10-01",
        periodEnd: "2026-10-31",
        totalSends: 500,
        totalDelivered: 500,
        uniqueOpens: 50,
        uniqueClicks: 5,
      }),
    ];
    const r = assess(src("eloqua"), rows, meta());
    const trend = r.sections!.find((s) => s.id === "email-trend")!.chart!;
    // August: 190 / 1100 (not the mean of 10% and 90%); September exists as an empty month.
    expect(trend.data).toEqual([
      { month: "Aug 2026", open: 17.27, click: 1.73 },
      { month: "Sep 2026", open: null, click: null },
      { month: "Oct 2026", open: 10, click: 1 },
    ]);
    expect(r.sections!.find((s) => s.id === "email-trend")!.group).toBe(
      "Campaigns",
    );
  });
  it("skips charts with nothing to draw and groups Unity readiness by blocker", () => {
    const empty = assess(src("eloqua"), [], meta());
    expect(empty.sections!.filter((s) => s.kind === "chart")).toEqual([]);
    const recs: RecordData[] = [
      row("profile", "p1", {
        sourceSystem: "crm",
        masterId: "M1",
        email: "a@x.test",
        country: "US",
      }),
      row("profile", "p2", {
        sourceSystem: "web",
        masterId: "M2",
        country: "US",
      }),
      row("profile", "p3", { sourceSystem: "web", email: "c@x.test" }),
      row("consent", "c1", {
        masterId: "M1",
        channel: "email",
        purpose: "marketing",
        status: "granted",
      }),
      row("destination", "D", {
        requiredFields: "email",
        consentChannel: "email",
        consentPurpose: "marketing",
      }),
      row("segment", "S", {
        name: "Aud",
        destinationId: "D",
        membershipComplete: true,
      }),
      row("membership", "m1", { segmentId: "S", memberId: "M1" }),
      row("membership", "m2", { segmentId: "S", memberId: "M2" }),
    ];
    const r = assess(src("unity"), recs, meta());
    const aud = r.sections!.find((s) => s.id === "audience-chart")!.chart!;
    expect(aud.data).toEqual([
      { audience: "Aud", ready: 1, field: 0, consent: 0, both: 1 },
    ]);
    const link = r.sections!.find((s) => s.id === "link-donut")!.chart!;
    expect(link.data.map((d) => d.records)).toEqual([2, 1]);
    expect(r.groups).toEqual([
      "Customers",
      "Data quality",
      "Consent",
      "Audiences",
      "Jobs",
    ]);
  });
});
