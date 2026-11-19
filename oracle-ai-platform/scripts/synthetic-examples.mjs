// Generates clearly SYNTHETIC, opt-in example uploads (examples/*.json). Deterministic.
// These are test/demo fixtures only: never load them into a customer production workspace.
import { writeFileSync, mkdirSync } from "node:fs";
let seed = 42;
const rnd = () =>
  (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pad = (n) => String(n).padStart(2, "0");
const iso = (d, h = 10, m = 0) => `2026-10-${pad(d)}T${pad(h)}:${pad(m)}:00Z`;
mkdirSync("examples", { recursive: true });

// ---------------- Eloqua ----------------
const eloqua = [];
const camp = (id, name, campaignType, objective, startDate, endDate) =>
  eloqua.push({
    type: "campaign",
    id,
    name: name + " (synthetic)",
    campaignType,
    objective,
    channel: "email",
    status: "completed",
    startDate,
    endDate,
  });
camp(
  "C-101",
  "Webinar invitation",
  "multistep",
  "registration",
  "2026-09-01",
  "2026-09-30",
);
camp(
  "C-102",
  "Product update",
  "simple",
  "engagement",
  "2026-10-01",
  "2026-10-15",
);
camp("C-103", "Q4 nurture", "multistep", "nurture", "2026-10-01", "2026-10-26");
const met = (id, campaignId, periodStart, periodEnd, v) =>
  eloqua.push({
    type: "campaign_metrics",
    id,
    campaignId,
    periodStart,
    periodEnd,
    openBasis: "bot-filtered",
    ...v,
  });
met("M-101", "C-101", "2026-09-01", "2026-09-30", {
  totalSends: 5000,
  totalDelivered: 4700,
  hardBounces: 200,
  softBounces: 100,
  uniqueOpens: 1400,
  totalOpens: 2100,
  uniqueClicks: 210,
  totalClicks: 260,
  unsubscribes: 40,
  formSubmissions: 60,
});
met("M-102", "C-102", "2026-10-01", "2026-10-15", {
  totalSends: 8000,
  totalDelivered: 7900,
  hardBounces: 50,
  softBounces: 50,
  uniqueOpens: 2400,
  totalOpens: 3300,
  uniqueClicks: 480,
  totalClicks: 610,
  unsubscribes: 20,
  formSubmissions: 30,
});
met("M-103", "C-103", "2026-10-01", "2026-10-26", {
  totalSends: 1200,
  totalDelivered: 1180,
  hardBounces: 10,
  softBounces: 10,
  uniqueOpens: 300,
  totalOpens: 380,
  uniqueClicks: 25,
  totalClicks: 31,
  unsubscribes: 15,
  formSubmissions: 4,
});
eloqua.push({
  type: "asset",
  id: "E-201",
  assetType: "email",
  name: "Webinar invite email (synthetic)",
  campaignId: "C-101",
  subject: "Join our webinar",
  mergeFields: "firstName",
  // Keeps two deliberate readiness issues for the checks: an image without alt text and an
  // http:// link.
  html:
    '<html><body><div style="max-width:600px;margin:0 auto;font-family:Arial,sans-serif;color:#333">' +
    '<img src="https://cdn.example.test/banner.png" style="width:100%">' +
    '<h1 style="font-size:24px;color:#1d1d1f">Join our live product webinar</h1>' +
    "<p>Hello {{firstName}},</p>" +
    "<p>In 45 minutes our team shows how to plan, launch and measure a campaign end to end, with time for your questions.</p>" +
    "<p><b>15 September, 15:00 UTC</b> · Online · Free</p>" +
    '<p><a href="http://example.test/register" style="background:#c74634;color:#fff;padding:12px 22px;border-radius:6px;text-decoration:none">Register now</a></p>' +
    '<p style="font-size:12px;color:#888">Synthetic example. You receive this because you subscribed. <a href="https://example.test/unsubscribe">Unsubscribe</a></p>' +
    "</div></body></html>",
});
eloqua.push({
  type: "asset",
  id: "E-202",
  assetType: "email",
  name: "Product update email (synthetic)",
  campaignId: "C-102",
  subject: "",
  html:
    '<html><body><div style="max-width:600px;margin:0 auto;font-family:Arial,sans-serif;color:#333">' +
    '<img src="https://cdn.example.test/x.png" alt="Product" style="width:100%">' +
    '<h1 style="font-size:24px;color:#1d1d1f">What is new this month</h1>' +
    "<p>Three improvements that save your team time: faster reports, simpler sharing and a new mobile view.</p>" +
    '<p><a href="https://example.test/news" style="background:#c74634;color:#fff;padding:12px 22px;border-radius:6px;text-decoration:none">Read the update</a></p>' +
    '<p style="font-size:12px;color:#888">Synthetic example. <a href="https://example.test/unsubscribe">Unsubscribe</a></p>' +
    "</div></body></html>",
});
eloqua.push({
  type: "asset",
  id: "F-301",
  assetType: "form",
  name: "Webinar form (synthetic)",
  campaignId: "C-101",
});
for (let i = 1; i <= 40; i++)
  eloqua.push({
    type: "contact",
    id: "K-" + i,
    emailDomain: i % 3 ? "example.test" : "example.org",
    accountId: "A-" + ((i % 5) + 1),
  });
let aid = 1;
const act = (
  activityType,
  d,
  contactId,
  campaignId,
  assetId,
  h = 9,
  extra = {},
) =>
  eloqua.push({
    type: "activity",
    id: "ACT-" + aid++,
    activityType,
    activityDate: iso(d, h),
    contactId,
    campaignId,
    assetId,
    isBot: false,
    ...extra,
  });
for (let i = 1; i <= 40; i++) {
  act("EmailSend", 5, "K-" + i, "C-103", "E-203", 8);
  if (i <= 18) act("EmailOpen", 5, "K-" + i, "C-103", "E-203", 9);
  if (i <= 10) act("EmailClickthrough", 5, "K-" + i, "C-103", "E-203", 10);
  if (i <= 3) act("FormSubmit", 6, "K-" + i, "C-103", "F-302", 11);
}
act("EmailOpen", 6, "K-99", "C-103", "E-203", 12); // unmatched: no send for this contact
act("EmailOpen", 6, "K-20", "C-103", "E-203", 12, { isBot: true }); // flagged automated activity
const step = (id, name, stepType, nextStepIds, isEntry = false) =>
  eloqua.push({
    type: "step",
    id,
    campaignId: "C-103",
    name,
    stepType,
    nextStepIds,
    isEntry,
  });
step("S-1", "Entry segment", "segment", "S-2", true);
step("S-2", "Welcome email", "email", "S-3");
step("S-3", "Wait 3 days", "wait", "S-4");
step("S-4", "Opened welcome?", "decision", "S-5;S-7");
step("S-5", "Follow-up email", "email", "");
step("S-6", "Legacy reminder", "email", "S-7");
step("S-7", "Exit", "end", "");
let sm = 1;
for (let i = 1; i <= 40; i++) {
  eloqua.push({
    type: "step_membership",
    id: "SM-" + sm++,
    campaignId: "C-103",
    stepId: "S-2",
    contactId: "K-" + i,
    enteredAt: iso(5, 8),
  });
  if (i <= 10)
    eloqua.push({
      type: "step_membership",
      id: "SM-" + sm++,
      campaignId: "C-103",
      stepId: "S-3",
      contactId: "K-" + i,
      enteredAt: iso(5, 9),
    });
}
// Leads, opportunities (CRM), events and website visits. Dates are UTC timestamps.
const at = (month, day, hour = 9) =>
  `2026-${pad(month)}-${pad(day)}T${pad(hour)}:00:00Z`;
const plus = (isoString, days) =>
  new Date(Date.parse(isoString) + days * 86_400_000)
    .toISOString()
    .replace(".000", "");
const sources = ["Webinar", "Paid search", "Organic", "Email"];
const leadCampaigns = ["C-101", "C-102", "C-103"];
let oppN = 1;
for (let i = 1; i <= 140; i++) {
  const month = i <= 60 ? 8 : i <= 110 ? 9 : 10;
  const created = at(month, 1 + (i % 27));
  const lead = {
    type: "lead",
    id: "L-" + i,
    contactId: "K-" + (200 + i),
    createdAt: created,
    leadSource: sources[i % 4],
    campaignId: i % 9 === 0 ? "C-102" : leadCampaigns[i % 2 === 0 ? 0 : 2],
    rating: ["A1", "A2", "B1", "B2", "C3", "D4"][i % 6],
    score: 20 + ((i * 37) % 80),
    stage: "Lead",
  };
  if (rnd() < 0.55) {
    lead.mqlAt = plus(created, 2 + (i % 5));
    lead.stage = "MQL";
    if (rnd() < 0.42) {
      lead.salAt = plus(lead.mqlAt, 1 + (i % 6));
      lead.stage = "SAL";
      if (rnd() < 0.65) {
        lead.sqlAt = plus(lead.salAt, 3 + (i % 7));
        lead.stage = "SQL";
        if (rnd() < 0.6) {
          lead.convertedAt = plus(lead.sqlAt, 2);
          lead.stage = "Opportunity";
          const opCreated = lead.convertedAt;
          const r = rnd();
          const outcome = r < 0.4 ? "won" : r < 0.75 ? "lost" : "open";
          const opp = {
            type: "opportunity",
            id: "OP-" + oppN++,
            leadId: lead.id,
            contactId: lead.contactId,
            campaignId: lead.campaignId,
            createdAt: opCreated,
            outcome,
            stage:
              outcome === "open"
                ? ["Discovery", "Proposal", "Negotiation"][i % 3]
                : outcome === "won"
                  ? "Closed won"
                  : "Closed lost",
            amount: 5000 + ((i * 1733) % 45000),
            currency: "USD",
          };
          if (outcome !== "open") opp.closedAt = plus(opCreated, 12 + (i % 30));
          eloqua.push(opp);
        }
      }
    } else if (rnd() < 0.15) {
      lead.disqualifiedAt = plus(lead.mqlAt, 4);
      lead.stage = "Disqualified";
    }
  }
  eloqua.push(lead);
}
// Older open opportunities (aged pipeline) and one in another currency (excluded from totals).
for (const [id, created, amount, currency] of [
  ["OP-OLD-1", "2026-05-04T10:00:00Z", 42000, "USD"],
  ["OP-OLD-2", "2026-06-11T10:00:00Z", 18000, "USD"],
  ["OP-EUR-1", "2026-09-20T10:00:00Z", 9000, "EUR"],
])
  eloqua.push({
    type: "opportunity",
    id,
    contactId: "K-9" + id.slice(-1),
    campaignId: "C-103",
    createdAt: created,
    outcome: "open",
    stage: "Proposal",
    amount,
    currency,
  });
const events = [
  [
    "EV-1",
    "Q3 product webinar (synthetic)",
    "webinar",
    "2026-09-15T15:00:00Z",
    "C-101",
    80,
    0.35,
  ],
  [
    "EV-2",
    "Customer roadshow Sydney (synthetic)",
    "in-person",
    "2026-10-08T23:00:00Z",
    "C-103",
    40,
    0.65,
  ],
  [
    "EV-3",
    "Year-end planning webinar (synthetic)",
    "webinar",
    "2026-11-20T15:00:00Z",
    "C-103",
    25,
    0,
  ],
];
for (const [id, name, eventType, startsAt, campaignId, n, show] of events) {
  eloqua.push({
    type: "marketing_event",
    id,
    name,
    eventType,
    startsAt,
    campaignId,
  });
  for (let k = 1; k <= n; k++) {
    const contact = "K-" + (200 + ((k * 7 + id.length * 13) % 140) + 1);
    const reg = {
      type: "event_registrant",
      id: id + "-R" + k,
      eventId: id,
      contactId: contact,
      registeredAt: plus(startsAt, -(1 + (k % 20))),
      cancelled: k % 17 === 0,
    };
    if (Date.parse(startsAt) < Date.parse("2026-10-28T00:00:00Z"))
      reg.attended = rnd() < show;
    eloqua.push(reg);
  }
}
const landing = ["/pricing", "/webinar", "/blog/q4-trends", "/product"];
for (let v = 1; v <= 220; v++) {
  const pageUrl = landing[v % 4];
  const known = v % 13 === 0;
  eloqua.push({
    type: "site_visit",
    id: "SV-" + v,
    visitedAt: at(10, 1 + Math.floor(rnd() * 27), 8 + (v % 10)),
    visitorId: "VIS-" + (v % 150),
    ...(known ? { contactId: "K-" + (200 + (v % 140) + 1) } : {}),
    firstPageUrl: pageUrl,
    pages: pageUrl === "/blog/q4-trends" ? 1 : 1 + Math.round(rnd() * 4),
    durationSeconds:
      pageUrl === "/blog/q4-trends"
        ? 2 + Math.round(rnd() * 6)
        : 20 + Math.round(rnd() * 240),
    referrer: v % 3 === 0 ? "email" : v % 3 === 1 ? "search" : "direct",
    ...(v % 3 === 0 ? { campaignId: "C-102" } : {}),
  });
}
// Three more campaigns with monthly results (Jul–Oct) so trends have several months.
for (const [id, name, objective, vol, eng] of [
  ["C-104", "Monthly newsletter", "engagement", 1.0, 1.0],
  ["C-105", "Product launch: tents", "acquisition", 0.8, 1.25],
  ["C-106", "Win-back lapsed buyers", "retention", 0.6, 0.6],
]) {
  camp(id, name, "simple", objective, "2026-07-01", "2026-10-27");
  for (const [m, last] of [
    [7, 31],
    [8, 31],
    [9, 30],
    [10, 27],
  ]) {
    const sends = Math.round((7000 + rnd() * 4000) * vol);
    const hard = Math.round(sends * (0.006 + rnd() * 0.006));
    const soft = Math.round(sends * (0.004 + rnd() * 0.004));
    const delivered = sends - hard - soft;
    const uo = Math.round(
      delivered * (0.2 + rnd() * 0.1 - (m - 7) * 0.012) * eng,
    );
    const uc = Math.round(uo * (0.13 + rnd() * 0.06) * eng);
    met(
      `M-${id}-${m}`,
      id,
      `2026-${pad(m)}-01`,
      `2026-${pad(m)}-${pad(last)}`,
      {
        totalSends: sends,
        totalDelivered: delivered,
        hardBounces: hard,
        softBounces: soft,
        uniqueOpens: uo,
        totalOpens: Math.round(uo * 1.5),
        uniqueClicks: uc,
        totalClicks: Math.round(uc * 1.3),
        unsubscribes: Math.round(delivered * (0.001 + rnd() * 0.002)),
        formSubmissions: Math.round(uc * 0.18),
      },
    );
  }
}
writeFileSync("examples/eloqua.json", JSON.stringify(eloqua, null, 1));

// ---------------- Unity ----------------
const unity = [];
for (let i = 1; i <= 60; i++) {
  const master = i <= 50 ? "M-" + (((i - 1) % 45) + 1) : null;
  unity.push({
    type: "profile",
    id: "SRC-" + i,
    sourceSystem: i % 2 ? "crm" : "web",
    masterId: master,
    email: i % 7 === 0 ? null : `person${((i - 1) % 45) + 1}@example.test`,
    phone: i % 4 === 0 ? null : "+1555000" + String(i).padStart(4, "0"),
    country: i % 6 === 0 ? null : "US",
    firstName: "Synthetic",
    updatedAt: i % 9 === 0 ? "2026-07-01T00:00:00Z" : iso(20),
  });
}
// duplicate candidate: same email on two different masters
unity.push({
  type: "profile",
  id: "SRC-61",
  sourceSystem: "web",
  masterId: "M-46",
  email: "person3@example.test",
  country: "US",
  updatedAt: iso(21),
});
for (let m = 1; m <= 46; m++) {
  if (m % 5 === 0) continue; // unknown consent
  const status = m % 11 === 0 ? "denied" : "granted";
  unity.push({
    type: "consent",
    id: "CON-" + m,
    masterId: "M-" + m,
    channel: "email",
    purpose: "marketing",
    status,
    effectiveDate: "2026-01-01",
    expiresAt: m % 8 === 0 ? "2026-06-30" : null,
  });
}
unity.push({
  type: "destination",
  id: "D-1",
  name: "Email service (synthetic)",
  requiredFields: "email;country",
  consentChannel: "email",
  consentPurpose: "marketing",
});
const seg = (id, name, complete, members) => {
  unity.push({
    type: "segment",
    id,
    name: name + " (synthetic)",
    definition: "synthetic",
    destinationId: "D-1",
    identityLevel: "master",
    membershipComplete: complete,
    snapshotAt: "2026-10-27T00:00:00Z",
    reportedCount: members.length + (complete ? 0 : 25),
  });
  members.forEach((m) =>
    unity.push({
      type: "membership",
      id: `${id}-${m}`,
      segmentId: id,
      memberId: "M-" + m,
    }),
  );
};
seg(
  "SEG-A",
  "Newsletter audience",
  true,
  Array.from({ length: 30 }, (_, i) => i + 1),
);
seg(
  "SEG-B",
  "Reactivation audience",
  true,
  Array.from({ length: 25 }, (_, i) => i + 16),
);
seg(
  "SEG-C",
  "Partial export audience",
  false,
  Array.from({ length: 10 }, (_, i) => i + 30),
);
const job = (
  id,
  name,
  jobType,
  status,
  startedAt,
  dependsOn = "",
  error = null,
) =>
  unity.push({
    type: "job",
    id,
    name,
    jobType,
    status,
    startedAt,
    completedAt: startedAt,
    dependsOn,
    error,
  });
job("J-1", "CRM ingest", "ingest", "succeeded", iso(26, 1));
job("J-2", "CRM ingest", "ingest", "succeeded", iso(27, 1));
job(
  "J-3",
  "Identity resolution",
  "identity_resolution",
  "succeeded",
  iso(26, 2),
  "CRM ingest",
);
job(
  "J-4",
  "Identity resolution",
  "identity_resolution",
  "failed",
  iso(27, 2),
  "CRM ingest",
  "Rule evaluation timed out (synthetic)",
);
job(
  "J-5",
  "Customer 360 build",
  "customer360",
  "succeeded",
  iso(26, 3),
  "Identity resolution",
);
// More customers from several systems and countries, SMS consent and an SMS audience.
const countries = ["US", "AU", "NZ", "GB", "IN", "CA"];
const systems = ["crm", "web", "store", "app"];
for (let i = 62; i <= 400; i++) {
  const m = 47 + Math.floor((i - 62) / 1.6);
  const month = 1 + (i % 10);
  unity.push({
    type: "profile",
    id: "SRC-" + i,
    sourceSystem: systems[i % 4],
    masterId: i % 13 === 0 ? null : "M-" + m,
    email: i % 9 === 0 ? null : `customer${m}@example.test`,
    phone: i % 5 === 0 ? null : "+61400" + String(i).padStart(6, "0"),
    country: i % 17 === 0 ? null : countries[(m * 7) % 6],
    firstName: "Synthetic",
    updatedAt: `2026-${pad(month)}-${pad(1 + (i % 27))}T08:00:00Z`,
  });
}
for (let m = 47; m <= 258; m++) {
  if (m % 6 !== 0)
    unity.push({
      type: "consent",
      id: "CON-E" + m,
      masterId: "M-" + m,
      channel: "email",
      purpose: "marketing",
      status: m % 10 === 0 ? "denied" : "granted",
      effectiveDate: "2026-03-01",
      expiresAt: m % 14 === 0 ? "2026-09-30" : null,
    });
  if (m % 3 !== 0)
    unity.push({
      type: "consent",
      id: "CON-S" + m,
      masterId: "M-" + m,
      channel: "sms",
      purpose: "marketing",
      status: m % 4 === 0 ? "denied" : "granted",
      effectiveDate: "2026-04-01",
    });
}
unity.push({
  type: "destination",
  id: "D-2",
  name: "SMS service (synthetic)",
  requiredFields: "phone;country",
  consentChannel: "sms",
  consentPurpose: "marketing",
});
unity.push({
  type: "segment",
  id: "SEG-D",
  name: "SMS promotion audience (synthetic)",
  definition: "synthetic",
  destinationId: "D-2",
  identityLevel: "master",
  membershipComplete: true,
  snapshotAt: "2026-10-27T00:00:00Z",
  reportedCount: 120,
});
for (let m = 47; m <= 166; m++)
  unity.push({
    type: "membership",
    id: "SEG-D-" + m,
    segmentId: "SEG-D",
    memberId: "M-" + m,
  });
// Two weeks of job runs (the latest Identity resolution run, J-4, stays the failed one).
let jn = 100;
for (let d = 13; d <= 25; d++) {
  job("J-" + jn++, "CRM ingest", "ingest", "succeeded", iso(d, 1));
  job(
    "J-" + jn++,
    "Web ingest",
    "ingest",
    d === 19 || d === 20 ? "failed" : "succeeded",
    iso(d, 1, 30),
    "",
    d === 19 || d === 20 ? "Source file missing (synthetic)" : null,
  );
  job(
    "J-" + jn++,
    "Identity resolution",
    "identity_resolution",
    "succeeded",
    iso(d, 2),
    "CRM ingest",
  );
}
job("J-" + jn++, "Web ingest", "ingest", "succeeded", iso(27, 1, 30));
writeFileSync("examples/unity.json", JSON.stringify(unity, null, 1));

// ---------------- Infinity ----------------
const inf = [];
inf.push({
  type: "report_manifest",
  id: "R-1",
  name: "Daily sessions by device (synthetic)",
  timezone: "UTC",
  startDate: "2026-10-10",
  endDate: "2026-10-27",
  extractedAt: "2026-10-28T06:00:00Z",
  sampled: false,
  truncated: false,
  rowsDisjoint: false,
  conversionDefinition: "Session with a purchase event",
});
for (let d = 10; d <= 27; d++) {
  const s = 900 + Math.round(rnd() * 120),
    mobile = Math.round(s * 0.6);
  inf.push({
    type: "report_row",
    id: `RT-${d}`,
    reportId: "R-1",
    date: `2026-10-${pad(d)}`,
    isTotal: true,
    sessions: s,
    convertedSessions: Math.round(s * 0.031),
  });
  inf.push({
    type: "report_row",
    id: `RM-${d}`,
    reportId: "R-1",
    date: `2026-10-${pad(d)}`,
    dimension: "device",
    dimensionValue: "mobile",
    sessions: mobile,
    convertedSessions: Math.round(mobile * 0.024),
  });
  inf.push({
    type: "report_row",
    id: `RD-${d}`,
    reportId: "R-1",
    date: `2026-10-${pad(d)}`,
    dimension: "device",
    dimensionValue: "desktop",
    sessions: s - mobile,
    convertedSessions: Math.round((s - mobile) * 0.041),
  });
}
// Saved page report (website performance): one row per page for the whole period, split by device.
const pagesReport = [
  ["/home", 5200, 2600, 1200, 1690, 41],
  ["/product", 3900, 900, 1300, 230, 72],
  ["/blog/q4-trends", 2100, 1400, 1650, 1120, 7],
  ["/checkout", 620, 30, 90, 6, 95],
];
for (const device of ["mobile", "desktop"])
  for (const [page, views, entries, exits, bounces, avgSec] of pagesReport) {
    const share = device === "mobile" ? 0.6 : 0.4;
    const v = Math.round(views * share),
      timed = Math.round((v - exits * share) * 0.95);
    inf.push({
      type: "page_metrics",
      id: `PM-${device}-${page}`,
      page,
      device,
      periodStart: "2026-10-10",
      periodEnd: "2026-10-27",
      pageViews: v,
      entries: Math.round(entries * share),
      exits: Math.round(exits * share),
      bounces: Math.round(bounces * share * (device === "mobile" ? 1.1 : 0.85)),
      timeOnPageSeconds: Math.round(
        timed * avgSec * (device === "mobile" ? 0.8 : 1.3),
      ),
      timedPageViews: timed,
    });
  }
inf.push({
  type: "tracking_spec",
  id: "view_product",
  requiredAttributes: "page;device",
  description: "Product page viewed",
});
inf.push({
  type: "tracking_spec",
  id: "view_article",
  requiredAttributes: "page",
  description: "Article or blog post viewed",
});
inf.push({
  type: "tracking_spec",
  id: "add_to_cart",
  requiredAttributes: "page;device",
  description: "Item added to cart",
});
inf.push({
  type: "tracking_spec",
  id: "checkout_start",
  requiredAttributes: "page",
  description: "Checkout started",
});
inf.push({
  type: "tracking_spec",
  id: "purchase",
  requiredAttributes: "page",
  description: "Order confirmed",
});
let eid = 1,
  sid = 1;
for (let d = 10; d <= 27; d++) {
  const sessions = d === 27 ? 4 : 10 + Math.round(rnd() * 3);
  for (let k = 0; k < sessions; k++) {
    const session = "SES-" + sid++,
      visitor = "V-" + (1 + (sid % 70)),
      device = rnd() < 0.6 ? "mobile" : "desktop",
      channel = rnd() < 0.5 ? "email" : "search";
    const ev = (event, min, extra = {}) =>
      inf.push({
        type: "event",
        id: "EV-" + eid++,
        event,
        timestamp: iso(d, 12, min),
        receivedAt: iso(d, 12, min + (rnd() < 0.05 ? 0 : 0)),
        sessionId: session,
        visitorId: visitor,
        page:
          {
            view_product: "/products/trail-tent-2p",
            add_to_cart: "/cart",
            checkout_start: "/checkout",
            purchase: "/order-confirmed",
          }[event] || "/" + event,
        device,
        channel,
        ...extra,
      });
    ev("view_product", 0);
    if (rnd() < 0.7) ev("add_to_cart", 3, rnd() < 0.15 ? { device: null } : {});
    else {
      // Some sessions read a blog post briefly before leaving.
      if (rnd() < 0.5) ev("view_article", 1, { page: "/blog/q4-trends" });
      continue;
    }
    if (rnd() < 0.35) ev("checkout_start", 6);
    else continue;
    if (rnd() < 0.7) ev("purchase", 9);
  }
}
// late-arriving event and a duplicate-event candidate
inf.push({
  type: "event",
  id: "EV-LATE",
  event: "view_product",
  timestamp: iso(26, 8),
  receivedAt: iso(26, 11),
  sessionId: "SES-LATE",
  visitorId: "V-1",
  page: "/p",
  device: "mobile",
  channel: "email",
});
inf.push({
  type: "event",
  id: "EV-DUP-1",
  event: "view_product",
  timestamp: iso(25, 7),
  receivedAt: iso(25, 7),
  sessionId: "SES-DUP",
  visitorId: "V-2",
  page: "/p",
  device: "desktop",
  channel: "search",
});
inf.push({
  type: "event",
  id: "EV-DUP-2",
  event: "view_product",
  timestamp: iso(25, 7),
  receivedAt: iso(25, 7),
  sessionId: "SES-DUP",
  visitorId: "V-2",
  page: "/p",
  device: "desktop",
  channel: "search",
});
inf.push({
  type: "event",
  id: "EV-UNKNOWN",
  event: "promo_banner_click",
  timestamp: iso(24, 9),
  receivedAt: iso(24, 9),
  sessionId: "SES-X",
  visitorId: "V-3",
  page: "/home",
  device: "mobile",
  channel: "search",
});
// Browsing sessions with page views at second-level timing (website performance and time spent).
inf.push({
  type: "tracking_spec",
  id: "page_view",
  requiredAttributes: "page;device",
  description: "Page viewed",
});
const paths = [
  [
    "/",
    "/category/tents",
    "/products/trail-tent-2p",
    "/products/trail-tent-4p",
  ],
  ["/", "/blog/packing-list"],
  ["/blog/packing-list"],
  [
    "/category/boots",
    "/products/alpine-boot",
    "/size-guide",
    "/products/alpine-boot",
  ],
  ["/", "/stores"],
  ["/sale"],
  ["/sale", "/category/tents", "/products/trail-tent-2p"],
];
const dwell = {
  "/": 25,
  "/category/tents": 40,
  "/category/boots": 45,
  "/products/trail-tent-2p": 95,
  "/products/trail-tent-4p": 80,
  "/products/alpine-boot": 110,
  "/size-guide": 60,
  "/blog/packing-list": 8,
  "/stores": 30,
  "/sale": 12,
};
const atSec = (d, sec) =>
  new Date(Date.parse(`2026-10-${pad(d)}T09:00:00Z`) + sec * 1000)
    .toISOString()
    .replace(".000", "");
let bid = 1;
for (let d = 10; d <= 27; d++) {
  const n = d === 27 ? 6 : 22 + Math.round(rnd() * 8);
  for (let k = 0; k < n; k++) {
    const session = `BRW-${d}-${k}`,
      visitor = "V-" + (100 + ((d * 31 + k) % 160));
    const device =
      rnd() < 0.55 ? "mobile" : rnd() < 0.85 ? "desktop" : "tablet";
    const channel = ["search", "email", "social", "direct"][
      Math.floor(rnd() * 4)
    ];
    let path = paths[Math.floor(rnd() * paths.length)];
    if (device === "mobile" && path.length > 1 && rnd() < 0.35)
      path = path.slice(0, 1);
    let t = k * 900 + Math.round(rnd() * 600);
    for (const page of path) {
      inf.push({
        type: "event",
        id: "BEV-" + bid++,
        event: "page_view",
        timestamp: atSec(d, t),
        receivedAt: atSec(d, t + 2),
        sessionId: session,
        visitorId: visitor,
        page,
        device,
        channel,
      });
      t += Math.max(3, Math.round(dwell[page] * (0.5 + rnd())));
    }
  }
}
writeFileSync("examples/infinity.json", JSON.stringify(inf, null, 1));
console.log(
  `SYNTHETIC examples written: eloqua ${eloqua.length}, unity ${unity.length}, infinity ${inf.length} records`,
);
