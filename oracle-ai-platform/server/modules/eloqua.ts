// Oracle Eloqua module: campaign portfolio, activity-level engagement, nurture structure and
// asset readiness. Identities stay distinct (campaign, asset, deployment, contact, activity);
// records are never joined by display name.
import Decimal from "decimal.js";
import type { RecordData, Report, Source } from "../../shared/catalog";
import {
  Assessment,
  D,
  bool,
  fmt,
  list,
  lower,
  ms,
  present,
  rate,
  sum,
  text,
  twoProportion,
  type AssessmentMeta,
  type RuleDef,
} from "./common";
import type {
  CompareResult,
  MetricDefinition,
  ModuleDefinition,
  ScenarioResult,
} from "./types";
import {
  REVENUE_METRICS,
  REVENUE_RULES,
  assessRevenue,
} from "./eloqua-revenue";
import { ELOQUA_LAYOUT, eloquaCharts } from "./eloqua-charts";

const VERSION = "eloqua-assessment-2026-11-02.1";
const DAY = 86_400_000;
const rule = (r: Omit<RuleDef, "version">): RuleDef => ({
  version: "v1",
  ...r,
});
const BASE_RULES: Record<string, RuleDef> = {
  bounce_rate: rule({
    title: "Review delivery: bounce rate above threshold",
    description:
      "Campaign bounce rate (hard + soft bouncebacks / total sends) exceeds the approved threshold for campaigns above the minimum send volume.",
    severity: "high",
    ownerRole: "Email operations",
    effort:
      "S (list hygiene review, ~1–2 h; basis: one segment and one bounce report)",
    automation: "B",
    targetMetric: "bounce_rate",
    nextChecks: [
      "Split bouncebacks by hard/soft and by email domain for this campaign.",
      "Check the segment source and recent list imports feeding this campaign.",
      "Confirm suppression of previously hard-bounced contacts.",
    ],
    dataNeeded: ["Bounceback activities with contact and email domain"],
    measurement:
      "Re-run after the next send; the rule clears when bounce rate is at or below the threshold.",
  }),
  unsubscribe_rate: rule({
    title: "Review audience fit: unsubscribe rate above threshold",
    description:
      "Unsubscribes / delivered exceeds the approved threshold for a campaign above minimum volume.",
    severity: "medium",
    ownerRole: "Campaign manager",
    effort: "S (segment and frequency review; basis: one campaign)",
    automation: "B",
    targetMetric: "unsubscribe_rate",
    nextChecks: [
      "Compare the campaign's audience criteria with its stated objective.",
      "Check how many emails these recipients received recently (exposure).",
    ],
    dataNeeded: ["EmailSend activities per contact for exposure analysis"],
    measurement: "Track unsubscribe rate on the next comparable send.",
  }),
  ctor_gap: rule({
    title: "Review content: click-to-open below portfolio",
    description:
      "Unique click-to-open rate is below the portfolio rate by at least the approved gap, for a campaign above minimum volume.",
    severity: "low",
    ownerRole: "Content owner",
    effort: "M (content review and test plan; basis: one email)",
    automation: "B",
    targetMetric: "ctor",
    nextChecks: [
      "Review the email's primary call to action and link placement.",
      "Draft an A/B test plan for the call to action (Draft studio).",
    ],
    dataNeeded: ["Click activities by link, if the export provides link URLs"],
    measurement:
      "Compare click-to-open on the next send against the portfolio baseline.",
  }),
  immature_activity: rule({
    title: "Recent sends: engagement still accruing",
    description:
      "Sends within the activity look-back window of the data's as-of time can still receive opens, clicks and form submissions.",
    severity: "info",
    ownerRole: "Analyst",
    effort: "None (wait and re-assess)",
    automation: "A",
    targetMetric: null,
    nextChecks: [
      "Re-run the assessment after the look-back window has passed.",
    ],
    dataNeeded: [],
    measurement:
      "Rates for these campaigns stabilize after the look-back window.",
  }),
  unmatched_activity: rule({
    title: "Reconcile unmatched activity",
    description:
      "Activities reference campaigns or contacts not present in this snapshot, or opens/clicks have no matching send in scope.",
    severity: "medium",
    ownerRole: "Marketing operations",
    effort: "S (export scope review)",
    automation: "B",
    targetMetric: "unmatched_activity",
    nextChecks: [
      "Check that the activity export and campaign export use the same date range and campaign scope.",
      "Confirm whether the sends happened before the export start date (delayed activity).",
    ],
    dataNeeded: [
      "Matching campaign metadata and EmailSend activities for the same scope",
    ],
    measurement:
      "Rule clears when unmatched activities fall to zero for the same scope.",
  }),
  exposure: rule({
    title: "Contacts above the approved send exposure",
    description:
      "Contacts received more emails than the approved maximum within the exposure window. This is a rule-based flag, separate from Oracle's native fatigue analysis.",
    severity: "medium",
    ownerRole: "Campaign manager",
    effort: "M (frequency policy and suppression review)",
    automation: "B",
    targetMetric: "exposed_contacts",
    nextChecks: [
      "Review which campaigns contributed sends to these contacts.",
      "Compare with Eloqua's native fatigue analysis if your subscription includes it.",
    ],
    dataNeeded: ["EmailSend activities per contact over the exposure window"],
    measurement: "Count of contacts above the threshold in the next snapshot.",
  }),
  nurture_unreachable: rule({
    title: "Nurture step cannot be reached",
    description:
      "A canvas step has no path from any entry step in the supplied structure.",
    severity: "medium",
    ownerRole: "Campaign builder",
    effort: "S (canvas review)",
    automation: "B",
    targetMetric: null,
    nextChecks: [
      "Open the campaign canvas and confirm the step's incoming connections.",
    ],
    dataNeeded: ["Complete step export with nextStepIds"],
    measurement:
      "Rule clears when the step is reachable in the next structure export.",
  }),
  nurture_dead_end: rule({
    title: "Nurture path ends without an end step",
    description: "A non-end step has no next step in the supplied structure.",
    severity: "low",
    ownerRole: "Campaign builder",
    effort: "S (canvas review)",
    automation: "B",
    targetMetric: null,
    nextChecks: ["Confirm whether contacts should exit here or continue."],
    dataNeeded: ["Complete step export with nextStepIds"],
    measurement:
      "Rule clears when the path has an explicit continuation or end.",
  }),
  nurture_drop: rule({
    title: "Nurture step loses most contacts",
    description:
      "Among contacts who entered a step (above minimum cohort), the share later entering a connected next step is below 100% − the approved drop-off threshold.",
    severity: "medium",
    ownerRole: "Campaign manager",
    effort: "M (step content and wait/decision logic review)",
    automation: "B",
    targetMetric: null,
    nextChecks: [
      "Check the decision rule or wait time at this step.",
      "Review the email or form used in the step and its engagement.",
    ],
    dataNeeded: ["Step membership history with entered/exited times"],
    measurement:
      "Progression share for this step in the next step-history export.",
  }),
  asset_readiness: rule({
    title: "Asset readiness issue",
    description:
      "An email asset fails a metadata, HTML or personalization check. A delivered-HTML check is not proof of inbox rendering or link availability.",
    severity: "low",
    ownerRole: "Content owner",
    effort: "S (asset edit in Eloqua by an authorized user)",
    automation: "B",
    targetMetric: null,
    nextChecks: [
      "Correct the asset in Eloqua, then re-export assets and re-assess.",
    ],
    dataNeeded: [
      "Asset HTML and merge-field list",
      "Contact fields used for personalization",
    ],
    measurement:
      "Rule clears when the asset passes all checks in the next export.",
  }),
  click_to_form: rule({
    title: "Few clickers submit the linked form",
    description:
      "Among eligible clickers (click at least one attribution window before as-of), the share with a linked form submission within the window is below 100% − the approved drop-off threshold.",
    severity: "low",
    ownerRole: "Web / form owner",
    effort: "M (form and landing page review)",
    automation: "B",
    targetMetric: "click_to_form",
    nextChecks: [
      "Review form length and required fields.",
      "Check landing-page load and errors.",
    ],
    dataNeeded: ["FormSubmit activities with contact IDs"],
    measurement: "Click-to-form progression in the next activity export.",
  }),
};
export const ELOQUA_RULES: Record<string, RuleDef> = {
  ...BASE_RULES,
  ...REVENUE_RULES,
};
const md = (
  id: string,
  label: string,
  grain: string,
  basis: MetricDefinition["basis"],
  numerator: string,
  denominator: string | null,
  timeBasis: string,
  exclusions: string,
  source: string,
): MetricDefinition => ({
  id,
  label,
  grain,
  basis,
  numerator,
  denominator,
  timeBasis,
  exclusions,
  source,
});
export const ELOQUA_METRICS: MetricDefinition[] = [
  md(
    "total_sends",
    "Total sends",
    "message",
    "total",
    "Σ totalSends",
    null,
    "Rows whose period lies fully inside the selected period",
    "Overlapping rows for the same campaign/email are withheld",
    "campaign_metrics",
  ),
  md(
    "delivered",
    "Delivered",
    "message",
    "total",
    "Σ totalDelivered (source) or, only when approved, Σ(sends − bounces)",
    null,
    "Same as total sends",
    "Derivation from bounces requires deliveryFromBounces=true",
    "campaign_metrics",
  ),
  md(
    "bounce_rate",
    "Bounce rate",
    "message",
    "derived",
    "Σ(hardBounces + softBounces)",
    "Σ totalSends",
    "Same",
    "Rows missing any input",
    "campaign_metrics",
  ),
  md(
    "unique_open_rate",
    "Unique open rate",
    "recipient / message",
    "derived",
    "Σ uniqueOpens",
    "Delivered",
    "Same",
    "Open signals may include privacy/automated opens unless the source filtered them",
    "campaign_metrics",
  ),
  md(
    "unique_click_rate",
    "Unique clickthrough rate",
    "recipient / message",
    "derived",
    "Σ uniqueClicks",
    "Delivered",
    "Same",
    "None",
    "campaign_metrics",
  ),
  md(
    "ctor",
    "Unique click-to-open rate",
    "recipient",
    "derived",
    "Σ uniqueClicks",
    "Σ uniqueOpens",
    "Same",
    "None",
    "campaign_metrics",
  ),
  md(
    "unsubscribe_rate",
    "Unsubscribe rate",
    "recipient / message",
    "derived",
    "Σ unsubscribes",
    "Delivered",
    "Same",
    "None",
    "campaign_metrics",
  ),
  md(
    "form_submissions",
    "Form submissions (source aggregate)",
    "event",
    "total",
    "Σ formSubmissions",
    null,
    "Same",
    "Not a conversion rate",
    "campaign_metrics",
  ),
  md(
    "activity_recipients",
    "Recipients sent (activity)",
    "contact",
    "unique",
    "Distinct contactId on EmailSend",
    null,
    "activityDate in period",
    "Bot-flagged activity when excludeBotActivity",
    "activity",
  ),
  md(
    "activity_open_rate",
    "Recipient open rate (activity)",
    "contact",
    "derived",
    "Distinct sent contacts with an EmailOpen in the same campaign",
    "Distinct sent contacts",
    "Same",
    "Opens without a matching send are unmatched",
    "activity",
  ),
  md(
    "click_to_form",
    "Click-to-form progression",
    "contact",
    "derived",
    "Eligible clickers with FormSubmit within the attribution window",
    "Clickers whose click is ≥ window before as-of",
    "Click time + window",
    "Clicks inside the last window (immature)",
    "activity",
  ),
  md(
    "unmatched_activity",
    "Unmatched activities",
    "activity",
    "total",
    "Activities without a matching campaign/contact/send in scope",
    null,
    "Same",
    "None",
    "activity",
  ),
  md(
    "exposed_contacts",
    "Contacts above exposure threshold",
    "contact",
    "unique",
    "Contacts with > exposureMaxSends sends in the trailing exposureWindowDays",
    null,
    "Window ending at as-of",
    "Requires approved thresholds",
    "activity",
  ),
  ...REVENUE_METRICS,
];

interface Stats {
  campaignId: string;
  rows: RecordData[];
  sends: Decimal | null;
  delivered: Decimal | null;
  deliveredDerived: boolean;
  bounces: Decimal | null;
  uniqueOpens: Decimal | null;
  uniqueClicks: Decimal | null;
  unsubscribes: Decimal | null;
  forms: Decimal | null;
  overlap: boolean;
  openBasisRaw: boolean;
  periodStart: string;
  periodEnd: string;
}
function overlapping(rows: RecordData[]) {
  const groups = new Map<string, RecordData[]>();
  for (const r of rows) {
    const k = text(r.campaignId) + "|" + text(r.emailId);
    groups.set(k, [...(groups.get(k) || []), r]);
  }
  const bad = new Set<string>();
  for (const g of groups.values()) {
    const sorted = [...g].sort((a, b) =>
      text(a.periodStart).localeCompare(text(b.periodStart)),
    );
    for (let i = 1; i < sorted.length; i++)
      if (text(sorted[i].periodStart) <= text(sorted[i - 1].periodEnd))
        bad.add(text(sorted[i].campaignId));
  }
  return bad;
}
function stats(
  campaignId: string,
  rows: RecordData[],
  fromBounces: boolean,
  overlap: boolean,
): Stats {
  const sends = sum(rows, "totalSends"),
    hard = sum(rows, "hardBounces"),
    soft = sum(rows, "softBounces"),
    bounces = hard && soft ? hard.plus(soft) : null;
  let delivered = sum(rows, "totalDelivered"),
    deliveredDerived = false;
  if (!delivered && fromBounces && sends && bounces) {
    delivered = sends.minus(bounces);
    deliveredDerived = true;
  }
  return {
    campaignId,
    rows,
    sends,
    delivered,
    deliveredDerived,
    bounces,
    uniqueOpens: sum(rows, "uniqueOpens"),
    uniqueClicks: sum(rows, "uniqueClicks"),
    unsubscribes: sum(rows, "unsubscribes"),
    forms: sum(rows, "formSubmissions"),
    overlap,
    openBasisRaw: rows.some((r) => lower(r.openBasis) !== "bot-filtered"),
    periodStart: rows.map((r) => text(r.periodStart)).sort()[0] || "",
    periodEnd:
      rows
        .map((r) => text(r.periodEnd))
        .sort()
        .at(-1) || "",
  };
}
const statRates = (s: Stats) => ({
  bounce: s.overlap ? null : rate(s.bounces, s.sends),
  open: s.overlap ? null : rate(s.uniqueOpens, s.delivered),
  click: s.overlap ? null : rate(s.uniqueClicks, s.delivered),
  ctor: s.overlap ? null : rate(s.uniqueClicks, s.uniqueOpens),
  unsub: s.overlap ? null : rate(s.unsubscribes, s.delivered),
});
function periodRows(a: Assessment) {
  const all = a.rows("campaign_metrics");
  const { periodStart, periodEnd } = a.meta;
  if (!periodStart && !periodEnd) return { rows: all, excluded: 0 };
  const rows = all.filter(
    (r) =>
      (!periodStart || text(r.periodStart) >= periodStart) &&
      (!periodEnd || text(r.periodEnd) <= periodEnd),
  );
  return { rows, excluded: all.length - rows.length };
}

function assess(
  source: Source,
  records: RecordData[],
  meta: AssessmentMeta,
): Report {
  const a = new Assessment(
    "eloqua",
    source,
    records,
    meta,
    ELOQUA_RULES,
    VERSION,
  );
  const minSends = a.policy("minSends", 100),
    bounceT = a.policy("bounceRateThreshold", 5),
    unsubT = a.policy("unsubscribeRateThreshold", 0.5),
    ctorGap = a.policy("ctorGapPp", 5),
    lookback = a.policy("activityLookbackDays", 3),
    window = a.policy("attributionWindowDays", 7),
    fromBounces = a.policy("deliveryFromBounces", false),
    excludeBots = a.policy("excludeBotActivity", true),
    dropT = a.policy("dropThreshold", 30),
    minCohort = a.policy("minCohort", 30);
  const asOf = Date.parse(meta.asOf);
  const campaigns = a.rows("campaign"),
    assets = a.rows("asset"),
    byCampaign = new Map(campaigns.map((c) => [c.id, c]));
  const name = (cid: string) => text(byCampaign.get(cid)?.name) || cid;

  // ---------- Aggregate (campaign_metrics) mode ----------
  const { rows: mRows, excluded } = periodRows(a);
  if (excluded)
    a.warnings.push(
      `${excluded} campaign metric rows extend beyond the selected period and were excluded; aggregates cannot be split by day.`,
    );
  const bad = overlapping(mRows);
  if (bad.size)
    a.warnings.push(
      `Overlapping metric periods for ${bad.size} campaign(s) (${[...bad].slice(0, 5).map(name).join(", ")}). Their totals are withheld to avoid double counting.`,
    );
  const clean = mRows.filter((r) => !bad.has(text(r.campaignId)));
  const portfolio = stats("portfolio", clean, fromBounces, false);
  const hasAgg = clean.length > 0;
  a.metric({
    id: "total_sends",
    label: "Total sends",
    value: hasAgg ? portfolio.sends : null,
    unit: "count",
    formula: "Σ totalSends (message level)",
    rows: clean,
    reason: hasAgg
      ? "Some rows lack totalSends"
      : "Upload campaign_metrics rows",
    grain: "message",
    basis: "total",
  });
  a.metric({
    id: "delivered",
    label: portfolio.deliveredDerived
      ? "Delivered (derived: sends − bounces)"
      : "Delivered",
    value: hasAgg ? portfolio.delivered : null,
    unit: "count",
    formula: portfolio.deliveredDerived
      ? "Σ(totalSends − hardBounces − softBounces); approved by deliveryFromBounces"
      : "Σ totalDelivered as reported by the source",
    rows: clean,
    reason:
      "totalDelivered is missing. Sends − bounces is used only when an administrator approves it (deliveryFromBounces).",
    grain: "message",
    basis: "total",
    state: portfolio.deliveredDerived ? "partial" : "observed",
  });
  const pr = statRates(portfolio);
  a.metric({
    id: "bounce_rate",
    label: "Bounce rate",
    value: pr.bounce,
    unit: "percent",
    formula: "Σ(hard + soft bouncebacks) / Σ totalSends × 100",
    rows: clean,
    reason: "Needs totalSends, hardBounces and softBounces on every row",
    grain: "message",
    basis: "derived",
  });
  a.metric({
    id: "unique_open_rate",
    label: "Unique open rate",
    value: pr.open,
    unit: "percent",
    formula: "Σ uniqueOpens / delivered × 100",
    rows: clean,
    reason: "Needs uniqueOpens and delivered",
    grain: "recipient / message",
    basis: "derived",
    state: portfolio.openBasisRaw ? "partial" : "observed",
  });
  a.metric({
    id: "unique_click_rate",
    label: "Unique clickthrough rate",
    value: pr.click,
    unit: "percent",
    formula: "Σ uniqueClicks / delivered × 100",
    rows: clean,
    reason: "Needs uniqueClicks and delivered",
    grain: "recipient / message",
    basis: "derived",
  });
  a.metric({
    id: "ctor",
    label: "Unique click-to-open rate",
    value: pr.ctor,
    unit: "percent",
    formula: "Σ uniqueClicks / Σ uniqueOpens × 100",
    rows: clean,
    reason: "Needs uniqueClicks and uniqueOpens",
    grain: "recipient",
    basis: "derived",
    state: portfolio.openBasisRaw ? "partial" : "observed",
  });
  a.metric({
    id: "unsubscribe_rate",
    label: "Unsubscribe rate",
    value: pr.unsub,
    unit: "percent",
    formula: "Σ unsubscribes / delivered × 100",
    rows: clean,
    reason: "Needs unsubscribes and delivered",
    grain: "recipient / message",
    basis: "derived",
  });
  a.metric({
    id: "form_submissions",
    label: "Form submissions (source aggregate)",
    value: hasAgg ? portfolio.forms : null,
    unit: "count",
    formula: "Σ formSubmissions as reported; events, not a conversion rate",
    rows: clean,
    reason: "formSubmissions not supplied",
    grain: "event",
    basis: "total",
  });
  if (hasAgg && portfolio.openBasisRaw)
    a.warnings.push(
      "Open counts are not marked as bot-filtered. Privacy and automated opens can inflate open-based rates; prefer clicks for conclusions.",
    );

  // Per-campaign stats
  const groups = new Map<string, RecordData[]>();
  for (const r of mRows)
    groups.set(text(r.campaignId), [
      ...(groups.get(text(r.campaignId)) || []),
      r,
    ]);
  const perCampaign = [...groups.entries()].map(([cid, rows]) =>
    stats(cid, rows, fromBounces, bad.has(cid)),
  );

  // ---------- Activity mode ----------
  const botField = a.rows("activity").some((r) => present(r.isBot));
  let acts = a.rows("activity").filter((r) => a.inPeriod(r, "activityDate"));
  const botCount = acts.filter((r) => bool(r.isBot)).length;
  if (botField && excludeBots) acts = acts.filter((r) => !bool(r.isBot));
  const typeOf = (r: RecordData) => lower(r.activityType);
  const sends = acts.filter((r) => typeOf(r) === "emailsend"),
    opens = acts.filter((r) => typeOf(r) === "emailopen"),
    clicks = acts.filter((r) => typeOf(r) === "emailclickthrough"),
    forms = acts.filter((r) => typeOf(r) === "formsubmit");
  const sentKey = new Set(
    sends
      .filter((r) => present(r.contactId))
      .map((r) => text(r.contactId) + "|" + text(r.campaignId)),
  );
  const recipients = new Set(
    sends.filter((r) => present(r.contactId)).map((r) => text(r.contactId)),
  );
  const hasActs = acts.length > 0;
  a.metric({
    id: "activity_messages_sent",
    label: "Messages sent (activity)",
    value: hasActs ? sends.length : null,
    unit: "count",
    formula: "Count of EmailSend activities",
    rows: sends,
    reason: "Upload activity records",
    grain: "message",
    basis: "total",
  });
  a.metric({
    id: "activity_recipients",
    label: "Recipients sent (activity)",
    value: hasActs ? recipients.size : null,
    unit: "count",
    formula: "Distinct contactId on EmailSend",
    rows: sends,
    reason: "Upload activity records",
    grain: "contact",
    basis: "unique",
  });
  const openers = new Set(
    opens
      .filter((r) => sentKey.has(text(r.contactId) + "|" + text(r.campaignId)))
      .map((r) => text(r.contactId)),
  );
  const clickers = new Set(
    clicks
      .filter((r) => sentKey.has(text(r.contactId) + "|" + text(r.campaignId)))
      .map((r) => text(r.contactId)),
  );
  a.metric({
    id: "activity_open_rate",
    label: "Recipient open rate (activity)",
    value: recipients.size ? rate(openers.size, recipients.size) : null,
    unit: "percent",
    formula:
      "Distinct sent contacts with a matching EmailOpen / distinct sent contacts × 100",
    rows: opens,
    reason: "Needs EmailSend and EmailOpen activities with contact IDs",
    grain: "contact",
    basis: "derived",
    state: botField ? "observed" : "partial",
  });
  a.metric({
    id: "activity_click_rate",
    label: "Recipient click rate (activity)",
    value: recipients.size ? rate(clickers.size, recipients.size) : null,
    unit: "percent",
    formula:
      "Distinct sent contacts with a matching EmailClickthrough / distinct sent contacts × 100",
    rows: clicks,
    reason: "Needs EmailSend and EmailClickthrough activities",
    grain: "contact",
    basis: "derived",
  });
  if (hasActs && !botField)
    a.warnings.push(
      "Activity export has no automated-activity flag (isBot); open-based activity rates are marked partial.",
    );
  if (botField && excludeBots && botCount)
    a.warnings.push(
      `${botCount} activities flagged by the source as automated were excluded.`,
    );

  // Unmatched activity
  const unmatched = acts.filter(
    (r) =>
      !present(r.contactId) ||
      (campaigns.length > 0 &&
        present(r.campaignId) &&
        !byCampaign.has(text(r.campaignId))) ||
      (["emailopen", "emailclickthrough"].includes(typeOf(r)) &&
        !sentKey.has(text(r.contactId) + "|" + text(r.campaignId))),
  );
  a.metric({
    id: "unmatched_activity",
    label: "Unmatched activities",
    value: hasActs ? unmatched.length : null,
    unit: "count",
    formula:
      "Activities lacking a contact, a known campaign, or (for opens/clicks) a matching send in scope",
    rows: unmatched,
    reason: "Upload activity records",
    grain: "activity",
    basis: "total",
  });
  if (unmatched.length)
    a.finding({
      rule: "unmatched_activity",
      scope: "activities",
      detail: `${unmatched.length} of ${acts.length} activities could not be matched to a campaign, contact or send in this snapshot. Delayed activity from sends before the export start is one possible reason.`,
      rows: unmatched,
      evidence: ["unmatched_activity"],
      affected: unmatched.length,
      hypotheses: [
        "Sends happened before the export start date (delayed activity).",
        "Campaign export covers a different scope than the activity export.",
      ],
    });

  // Maturity (delayed activity)
  const recent = sends.filter(
    (r) => asOf - ms(r.activityDate) < lookback * DAY,
  );
  const immatureCampaigns = new Set(recent.map((r) => text(r.campaignId)));
  for (const s of perCampaign)
    if (Date.parse(s.periodEnd + "T23:59:59Z") > asOf - lookback * DAY)
      immatureCampaigns.add(s.campaignId);
  if (immatureCampaigns.size)
    a.finding({
      rule: "immature_activity",
      scope: "recent-sends",
      detail: `${immatureCampaigns.size} campaign(s) had sends within ${lookback} day(s) of the data as-of time; their open, click and form figures can still grow.`,
      affected: immatureCampaigns.size,
      rows: [...immatureCampaigns]
        .map((c) => byCampaign.get(c))
        .filter(Boolean) as RecordData[],
    });

  // Click-to-form journey (linked activity, explicit window)
  const formByContact = new Map<string, number[]>();
  for (const f of forms)
    if (present(f.contactId))
      formByContact.set(text(f.contactId), [
        ...(formByContact.get(text(f.contactId)) || []),
        ms(f.activityDate),
      ]);
  const eligibleClick = new Map<string, number>();
  for (const c of clicks)
    if (present(c.contactId) && ms(c.activityDate) <= asOf - window * DAY) {
      const k = text(c.contactId),
        t = ms(c.activityDate);
      if (!eligibleClick.has(k) || t < eligibleClick.get(k)!)
        eligibleClick.set(k, t);
    }
  const progressed = [...eligibleClick.entries()].filter(([k, t]) =>
    (formByContact.get(k) || []).some(
      (ft) => ft >= t && ft - t <= window * DAY,
    ),
  ).length;
  const formsAvailable = forms.length > 0;
  const ctf = a.metric({
    id: "click_to_form",
    label: "Click-to-form progression",
    value:
      formsAvailable && eligibleClick.size
        ? rate(progressed, eligibleClick.size)
        : null,
    unit: "percent",
    formula: `Eligible clickers with a FormSubmit within ${window} day(s) after their first click / clickers whose click is at least ${window} day(s) before as-of × 100`,
    rows: clicks,
    reason: formsAvailable
      ? "No clicks old enough for the attribution window"
      : "FormSubmit activities are not in this export; the source aggregate form count is not a linked journey",
    grain: "contact",
    basis: "derived",
  });
  if (ctf && eligibleClick.size >= minCohort && ctf.lt(100 - dropT))
    a.finding({
      rule: "click_to_form",
      scope: "click-to-form",
      detail: `${progressed} of ${eligibleClick.size} eligible clickers submitted a form within ${window} day(s).`,
      evidence: ["click_to_form"],
      affected: eligibleClick.size - progressed,
    });

  // Exposure (rule-based, thresholds must be approved)
  const maxSends = source.policy.exposureMaxSends as number | undefined,
    expWin = source.policy.exposureWindowDays as number | undefined;
  if (maxSends && expWin && sends.length) {
    a.thresholds.exposureMaxSends = maxSends;
    a.thresholds.exposureWindowDays = expWin;
    const counts = new Map<string, number>();
    for (const s of a.rows("activity"))
      if (
        lower(s.activityType) === "emailsend" &&
        present(s.contactId) &&
        ms(s.activityDate) > asOf - expWin * DAY &&
        ms(s.activityDate) <= asOf
      )
        counts.set(text(s.contactId), (counts.get(text(s.contactId)) || 0) + 1);
    const exposed = [...counts.values()].filter((n) => n > maxSends).length;
    a.metric({
      id: "exposed_contacts",
      label: "Contacts above exposure threshold",
      value: exposed,
      unit: "count",
      formula: `Contacts with more than ${maxSends} EmailSend activities in the ${expWin} days ending at as-of (rule-based, not Oracle fatigue prediction)`,
      grain: "contact",
      basis: "unique",
    });
    if (exposed)
      a.finding({
        rule: "exposure",
        scope: "exposure",
        detail: `${exposed} contacts received more than ${maxSends} emails in ${expWin} days.`,
        evidence: ["exposed_contacts"],
        affected: exposed,
      });
  } else
    a.metric({
      id: "exposed_contacts",
      label: "Contacts above exposure threshold",
      value: null,
      unit: "count",
      formula:
        "Requires approved exposureMaxSends and exposureWindowDays plus send activity",
      reason:
        "An administrator must approve exposure thresholds in the source policy",
    });

  // Campaign-level rules
  const portfolioCtor = pr.ctor;
  for (const s of perCampaign) {
    const c = byCampaign.get(s.campaignId) || {
      id: s.campaignId,
      type: "campaign",
    };
    const r = statRates(s);
    if (s.overlap || !s.sends || s.sends.lt(minSends)) continue;
    const imm = immatureCampaigns.has(s.campaignId);
    if (r.bounce && r.bounce.gt(bounceT))
      a.finding({
        rule: "bounce_rate",
        entity: c,
        detail: `${name(s.campaignId)}: bounce rate ${r.bounce.toDecimalPlaces(2)}% on ${s.sends} sends (threshold ${bounceT}%).`,
        evidence: ["bounce_rate"],
        affected: s.sends.toNumber(),
        rows: s.rows,
        hypotheses: [
          "A recent list import added invalid addresses.",
          "Previously bounced contacts are not suppressed.",
        ],
      });
    if (r.unsub && r.unsub.gt(unsubT))
      a.finding({
        rule: "unsubscribe_rate",
        entity: c,
        detail: `${name(s.campaignId)}: unsubscribe rate ${r.unsub.toDecimalPlaces(2)}% (threshold ${unsubT}%).`,
        evidence: ["unsubscribe_rate"],
        affected: s.delivered?.toNumber() || 0,
        rows: s.rows,
        partial: imm,
        hypotheses: [
          "Audience does not match the campaign objective.",
          "Recipients received many recent emails.",
        ],
      });
    if (r.ctor && portfolioCtor && portfolioCtor.minus(r.ctor).gte(ctorGap))
      a.finding({
        rule: "ctor_gap",
        entity: c,
        detail: `${name(s.campaignId)}: click-to-open ${r.ctor.toDecimalPlaces(2)}% vs portfolio ${portfolioCtor.toDecimalPlaces(2)}% (gap threshold ${ctorGap} percentage points).`,
        evidence: ["ctor"],
        affected: s.uniqueOpens?.toNumber() || 0,
        rows: s.rows,
        partial: imm || s.openBasisRaw,
        caveats: s.openBasisRaw
          ? ["Opens are not bot-filtered, so click-to-open may be understated."]
          : [],
      });
  }
  a.section({
    id: "campaigns",
    kind: "table",
    title: "Campaign performance",
    subtitle:
      "Rates aggregate each campaign's numerators and denominators; portfolio rates are never averages of campaign percentages.",
    columns: [
      { key: "campaign", label: "Campaign" },
      { key: "period", label: "Period" },
      { key: "sends", label: "Sends", unit: "count" },
      { key: "delivered", label: "Delivered", unit: "count" },
      { key: "bounce", label: "Bounce %", unit: "percent" },
      { key: "open", label: "Unique open %", unit: "percent" },
      { key: "click", label: "Unique click %", unit: "percent" },
      { key: "ctor", label: "Click-to-open %", unit: "percent" },
      { key: "unsub", label: "Unsubscribe %", unit: "percent" },
      { key: "status", label: "Data status" },
    ],
    rows: perCampaign.map((s) => {
      const r = statRates(s);
      return {
        key: "campaign:" + s.campaignId,
        campaign: name(s.campaignId),
        period: s.periodStart + " – " + s.periodEnd,
        sends: fmt(s.sends),
        delivered: s.overlap ? null : fmt(s.delivered),
        bounce: fmt(r.bounce),
        open: fmt(r.open),
        click: fmt(r.click),
        ctor: fmt(r.ctor),
        unsub: fmt(r.unsub),
        status: s.overlap
          ? "Overlapping periods: withheld"
          : immatureCampaigns.has(s.campaignId)
            ? "Still accruing"
            : !s.sends || s.sends.lt(minSends)
              ? `Below ${minSends} sends`
              : "Comparable",
      };
    }),
  });
  if (perCampaign.length > 0)
    a.section({
      id: "click-chart",
      kind: "bars",
      title: "Unique clickthrough rate by campaign",
      unit: "percent",
      bars: perCampaign.slice(0, 20).map((s) => ({
        label: name(s.campaignId),
        value: s.overlap ? null : (statRates(s).click?.toNumber() ?? null),
        note: s.sends ? `${s.sends} sends` : undefined,
      })),
      note: "Bars without a value are unavailable, not zero.",
    });

  // ---------- Nurture structure and step history ----------
  const steps = a.rows("step"),
    hist = a.rows("step_membership");
  const stepRows: Record<string, unknown>[] = [];
  for (const cid of new Set(steps.map((s) => text(s.campaignId)))) {
    const cs = steps.filter((s) => text(s.campaignId) === cid),
      byId = new Map(cs.map((s) => [s.id, s]));
    const incoming = new Set(cs.flatMap((s) => list(s.nextStepIds)));
    const entries = cs.filter((s) => bool(s.isEntry) || !incoming.has(s.id));
    const reach = new Set<string>(),
      queue = entries.map((e) => e.id);
    while (queue.length) {
      const n = queue.shift()!;
      if (reach.has(n)) continue;
      reach.add(n);
      for (const nx of list(byId.get(n)?.nextStepIds))
        if (byId.has(nx)) queue.push(nx);
    }
    for (const s of cs) {
      if (!reach.has(s.id))
        a.finding({
          rule: "nurture_unreachable",
          entity: s,
          detail: `${name(cid)} › ${text(s.name) || s.id} has no path from an entry step.`,
        });
      if (lower(s.stepType) !== "end" && !list(s.nextStepIds).length)
        a.finding({
          rule: "nurture_dead_end",
          entity: s,
          detail: `${name(cid)} › ${text(s.name) || s.id} (${text(s.stepType)}) has no next step.`,
        });
      const entered = new Set(
        hist
          .filter((h) => text(h.stepId) === s.id)
          .map((h) => text(h.contactId)),
      );
      const nextIds = list(s.nextStepIds);
      const moved = new Set(
        hist
          .filter(
            (h) =>
              nextIds.includes(text(h.stepId)) &&
              entered.has(text(h.contactId)),
          )
          .map((h) => text(h.contactId)),
      );
      const progression =
        hist.length && nextIds.length && entered.size
          ? rate(moved.size, entered.size)
          : null;
      stepRows.push({
        key: "step:" + s.id,
        campaign: name(cid),
        step: text(s.name) || s.id,
        type: text(s.stepType),
        entered: hist.length ? entered.size : null,
        progressed: hist.length && nextIds.length ? moved.size : null,
        progression: fmt(progression),
      });
      if (
        progression &&
        entered.size >= minCohort &&
        progression.lt(100 - dropT)
      )
        a.finding({
          rule: "nurture_drop",
          entity: s,
          detail: `${name(cid)} › ${text(s.name) || s.id}: ${moved.size} of ${entered.size} contacts reached a connected next step.`,
          affected: entered.size - moved.size,
        });
    }
  }
  if (steps.length)
    a.section({
      id: "nurture",
      kind: "table",
      title: "Nurture structure and step progression",
      subtitle: hist.length
        ? "Progression uses supplied step-membership history only."
        : "Structure only. Step progression needs step-membership history; a current status field cannot show past transitions.",
      columns: [
        { key: "campaign", label: "Campaign" },
        { key: "step", label: "Step" },
        { key: "type", label: "Type" },
        { key: "entered", label: "Entered", unit: "count" },
        { key: "progressed", label: "Reached next step", unit: "count" },
        { key: "progression", label: "Progression %", unit: "percent" },
      ],
      rows: stepRows,
    });

  // ---------- Asset readiness ----------
  const contacts = a.rows("contact");
  const contactFields = new Set(contacts.flatMap((c) => Object.keys(c)));
  const readiness: Record<string, unknown>[] = [];
  for (const as of assets.filter((x) => lower(x.assetType) === "email")) {
    const issues: string[] = [];
    if (!present(as.subject)) issues.push("missing subject line");
    const html = text(as.html);
    if (html) {
      const imgs = html.match(/<img\b[^>]*>/gi) || [];
      const noAlt = imgs.filter((i) => !/\balt\s*=\s*"[^"]+"/i.test(i)).length;
      if (noAlt) issues.push(`${noAlt} image(s) without alt text`);
      const httpLinks = (html.match(/href\s*=\s*"http:\/\//gi) || []).length;
      if (httpLinks) issues.push(`${httpLinks} non-HTTPS link(s)`);
      const empty = (html.match(/href\s*=\s*"(#|)"/gi) || []).length;
      if (empty) issues.push(`${empty} empty link(s)`);
      if (Buffer.byteLength(html) > 102_000)
        issues.push("HTML over 102 KB (some inboxes clip large messages)");
    }
    for (const field of list(as.mergeFields)) {
      if (!contacts.length || !contactFields.has(field))
        issues.push(
          `merge field ${field}: coverage cannot be verified (field not in contact export)`,
        );
      else {
        const cov = rate(
          contacts.filter((c) => present(c[field])).length,
          contacts.length,
        )!;
        if (cov.lt(100))
          issues.push(
            `merge field ${field} populated for ${cov.toDecimalPlaces(1)}% of contacts`,
          );
      }
    }
    if (present(as.brandApproved) && !bool(as.brandApproved))
      issues.push("not approved against the brand playbook");
    readiness.push({
      key: "asset:" + as.id,
      asset: text(as.name) || as.id,
      campaign: present(as.campaignId) ? name(text(as.campaignId)) : "—",
      checks: issues.length ? issues.join("; ") : "All supplied checks passed",
      html: html ? "Supplied" : "Not supplied",
    });
    if (issues.length)
      a.finding({
        rule: "asset_readiness",
        entity: as,
        detail: `${text(as.name) || as.id}: ${issues.join("; ")}.`,
        caveats: [
          "Delivered-HTML checks do not prove inbox rendering or that links resolve.",
        ],
      });
  }
  if (assets.length)
    a.section({
      id: "assets",
      kind: "table",
      title: "Asset readiness review",
      subtitle:
        "Checks supplied metadata and HTML. Inbox rendering and live link checks are out of scope.",
      columns: [
        { key: "asset", label: "Email asset" },
        { key: "campaign", label: "Campaign" },
        { key: "html", label: "HTML" },
        { key: "checks", label: "Checks" },
      ],
      rows: readiness,
    });

  // ---------- Capabilities / missing-data checklist ----------
  a.capability(
    "campaigns",
    "Campaign metadata",
    campaigns.length > 0,
    "Export campaigns (ID, name, type, objective, dates) to label and compare campaigns.",
  );
  a.capability(
    "aggregates",
    "Campaign-period metrics",
    hasAgg ? (portfolio.openBasisRaw ? "partial" : true) : false,
    "Export campaign email metrics per campaign and period (sends, delivered, bounces, unique opens/clicks, unsubscribes).",
  );
  a.capability(
    "activities",
    "Recipient-level activity",
    hasActs ? (botField ? true : "partial") : false,
    "Bulk activity export: EmailSend, EmailOpen, EmailClickthrough, Bounceback, Unsubscribe, FormSubmit with contact and campaign IDs (add isBot when available).",
  );
  a.capability(
    "forms",
    "Click-to-form journey",
    formsAvailable && clicks.length > 0,
    "FormSubmit and EmailClickthrough activities with contact IDs.",
  );
  a.capability(
    "nurture",
    "Nurture structure",
    steps.length > 0,
    "Campaign canvas steps with nextStepIds.",
  );
  a.capability(
    "history",
    "Nurture step progression",
    hist.length > 0,
    "Step membership history (contact, step, entered/exited time).",
  );
  a.capability(
    "assets",
    "Asset readiness",
    assets.length > 0
      ? assets.some((x) => present(x.html))
        ? true
        : "partial"
      : false,
    "Email assets with subject, HTML and merge-field list.",
  );
  a.capability(
    "exposure",
    "Exposure analysis",
    !!(maxSends && expWin && sends.length),
    "Approved exposure thresholds plus EmailSend activities per contact.",
  );
  eloquaCharts(a, name, bad);
  assessRevenue(
    a,
    name,
    new Map(
      perCampaign.map((s) => [s.campaignId, s.overlap ? null : s.delivered]),
    ),
  );
  return a.build();
}

function select(all: RecordData[], keys: string[]) {
  if (!keys.length) return all;
  const chosen = new Set(keys);
  const campaignIds = new Set([
    ...keys
      .filter((k) => k.startsWith("campaign:"))
      .map((k) => k.slice("campaign:".length)),
    ...all
      .filter((r) => chosen.has(r.type + ":" + r.id) && present(r.campaignId))
      .map((r) => text(r.campaignId)),
  ]);
  const out = all.filter(
    (r) =>
      chosen.has(r.type + ":" + r.id) ||
      (r.type === "campaign" && campaignIds.has(r.id)) ||
      ([
        "campaign_metrics",
        "asset",
        "activity",
        "step",
        "step_membership",
        "lead",
        "opportunity",
        "marketing_event",
        "site_visit",
      ].includes(r.type) &&
        campaignIds.has(text(r.campaignId))),
  );
  // Events: the chosen or campaign-linked events, their registrants and attendee opportunities.
  const eventIds = new Set([
    ...keys
      .filter((k) => k.startsWith("event:"))
      .map((k) => k.slice("event:".length)),
    ...out.filter((r) => r.type === "marketing_event").map((r) => r.id),
  ]);
  out.push(
    ...all.filter(
      (r) =>
        (r.type === "marketing_event" &&
          eventIds.has(r.id) &&
          !out.includes(r)) ||
        (r.type === "event_registrant" && eventIds.has(text(r.eventId))),
    ),
  );
  const contactIds = new Set(
    out.filter((r) => present(r.contactId)).map((r) => text(r.contactId)),
  );
  const leadIds = new Set(
    out.filter((r) => r.type === "lead").map((r) => r.id),
  );
  return [
    ...new Map(
      [
        ...out,
        ...all.filter(
          (r) =>
            (r.type === "contact" && contactIds.has(r.id)) ||
            (r.type === "opportunity" &&
              (leadIds.has(text(r.leadId)) ||
                (eventIds.size > 0 && contactIds.has(text(r.contactId))))),
        ),
      ].map((r) => [r.type + ":" + r.id, r]),
    ).values(),
  ];
}

function validateBatch(records: RecordData[]) {
  const errors: { row: number; message: string }[] = [],
    warnings: string[] = [];
  const ids = (t: string) =>
    new Set(records.filter((r) => r.type === t).map((r) => r.id));
  const campaigns = ids("campaign"),
    steps = ids("step");
  records.forEach((r, i) => {
    if (
      r.type === "campaign_metrics" &&
      text(r.periodStart) > text(r.periodEnd)
    )
      errors.push({ row: i + 1, message: "periodStart is after periodEnd" });
    if (
      r.type === "step_membership" &&
      steps.size &&
      !steps.has(text(r.stepId))
    )
      errors.push({
        row: i + 1,
        message: `Step ${text(r.stepId)} is not in this batch's step export`,
      });
    for (const k of [
      "totalDelivered",
      "uniqueOpens",
      "uniqueClicks",
      "hardBounces",
      "softBounces",
    ])
      if (
        r.type === "campaign_metrics" &&
        D(r[k]) &&
        D(r.totalSends) &&
        D(r[k])!.gt(D(r.totalSends)!)
      )
        errors.push({ row: i + 1, message: `${k} exceeds totalSends` });
    if (
      r.type === "campaign_metrics" &&
      D(r.uniqueClicks) &&
      D(r.uniqueOpens) &&
      D(r.uniqueClicks)!.gt(D(r.uniqueOpens)!)
    )
      warnings.push(
        `Row ${i + 1}: unique clicks exceed unique opens (opens may be under-counted by image blocking).`,
      );
  });
  const events = ids("marketing_event");
  records.forEach((r, i) => {
    if (r.type === "opportunity") {
      if (!["open", "won", "lost"].includes(lower(r.outcome)))
        errors.push({
          row: i + 1,
          message: "outcome must be open, won or lost",
        });
      if (D(r.amount) && D(r.amount)!.lt(0))
        errors.push({ row: i + 1, message: "amount is negative" });
      if (present(r.closedAt) && ms(r.closedAt) < ms(r.createdAt))
        errors.push({ row: i + 1, message: "closedAt is before createdAt" });
      if (lower(r.outcome) !== "open" && !present(r.closedAt))
        warnings.push(
          `Row ${i + 1}: a ${lower(r.outcome)} opportunity has no closedAt; it is left out of period win rate and revenue.`,
        );
      if (present(r.currency) && !/^[A-Za-z]{3}$/.test(text(r.currency)))
        errors.push({
          row: i + 1,
          message: "currency must be a 3-letter code",
        });
    }
    if (r.type === "lead")
      for (const [x, y] of [
        ["createdAt", "mqlAt"],
        ["mqlAt", "salAt"],
        ["salAt", "sqlAt"],
      ])
        if (present(r[x]) && present(r[y]) && ms(r[y]) < ms(r[x]))
          errors.push({ row: i + 1, message: `${y} is before ${x}` });
    if (
      r.type === "event_registrant" &&
      events.size &&
      !events.has(text(r.eventId))
    )
      errors.push({
        row: i + 1,
        message: `Event ${text(r.eventId)} is not in this batch's event export`,
      });
    if (r.type === "site_visit" && D(r.durationSeconds)?.lt(0))
      errors.push({ row: i + 1, message: "durationSeconds is negative" });
  });
  if (campaigns.size) {
    const missing = new Set(
      records
        .filter(
          (r) =>
            [
              "campaign_metrics",
              "activity",
              "step",
              "lead",
              "opportunity",
            ].includes(r.type) &&
            present(r.campaignId) &&
            !campaigns.has(text(r.campaignId)),
        )
        .map((r) => text(r.campaignId)),
    );
    if (missing.size)
      warnings.push(
        `${missing.size} campaign ID(s) are referenced but not in the campaign export; they will be assessed as unmatched.`,
      );
  }
  return { errors, warnings };
}

function simulate(input: Record<string, unknown>): ScenarioResult {
  const n = (k: string, max?: number, optional = false) => {
    const v = D(input[k]);
    if (v === null && optional) return null;
    if (v === null || v.lt(0) || (max !== undefined && v.gt(max)))
      throw Error(
        `Enter a valid ${k}${max !== undefined ? " from 0 to " + max : ""}`,
      );
    return v;
  };
  const delivered = n("delivered")!,
    base = n("baselineClickRate", 100)!,
    proposed = n("proposedClickRate", 100)!,
    form = n("clickToFormRate", 100, true),
    oppRate = n("formToOpportunityRate", 100, true),
    winRate = n("winRate", 100, true),
    deal = n("avgDeal", undefined, true);
  const currency = String(input.currency || "").toUpperCase();
  if ((oppRate || winRate || deal) && !form)
    throw Error("Pipeline assumptions need a click-to-form rate first");
  if (deal && !/^[A-Z]{3}$/.test(currency))
    throw Error("A deal value needs a three-letter currency code");
  const clickersBase = delivered.mul(base).div(100),
    clickersNew = delivered.mul(proposed).div(100);
  const addForms = form
    ? clickersNew.minus(clickersBase).mul(form).div(100)
    : null;
  const addOpps = addForms && oppRate ? addForms.mul(oppRate).div(100) : null;
  const addWins = addOpps && winRate ? addOpps.mul(winRate).div(100) : null;
  return {
    kind: "assumption",
    formulaVersion: "eloqua-scenario-v1",
    formula:
      "Projected clickers = delivered × assumed click rate. Additional form submitters = additional clickers × click-to-form rate; additional opportunities = that × form-to-opportunity rate; additional wins = that × win rate; hypothetical revenue = wins × average deal.",
    measured: { delivered: fmt(delivered), baselineClickRate: fmt(base) },
    assumed: {
      proposedClickRate: fmt(proposed)!,
      ...(form ? { clickToFormRate: fmt(form)! } : {}),
      ...(oppRate ? { formToOpportunityRate: fmt(oppRate)! } : {}),
      ...(winRate ? { winRate: fmt(winRate)! } : {}),
      ...(deal ? { avgDeal: fmt(deal)!, currency } : {}),
    },
    projected: {
      clickersAtBaseline: fmt(clickersBase),
      clickersAtProposed: fmt(clickersNew),
      additionalClickers: fmt(clickersNew.minus(clickersBase)),
      additionalFormSubmitters: fmt(addForms),
      additionalOpportunities: fmt(addOpps),
      additionalWins: fmt(addWins),
      hypotheticalRevenue: addWins && deal ? fmt(addWins.mul(deal)) : null,
    },
    currency: deal ? currency : undefined,
    unit: "contacts",
    note: "Hypothetical projection from your assumptions. It is not a forecast, does not imply that a change causes uplift and does not change Eloqua data.",
  };
}

function compare(
  source: Source,
  all: RecordData[],
  keys: string[],
  meta: AssessmentMeta,
): CompareResult {
  const fromBounces = source.policy.deliveryFromBounces === true,
    minSends = Number(source.policy.minSends ?? 100),
    lookback = Number(source.policy.activityLookbackDays ?? 3);
  const metrics = all.filter((r) => r.type === "campaign_metrics");
  const bad = overlapping(metrics);
  const known = new Set(metrics.map((m) => "campaign:" + text(m.campaignId)));
  const camps = keys.map(
    (k) =>
      all.find((r) => r.type === "campaign" && "campaign:" + r.id === k) ||
      (known.has(k)
        ? ({ id: k.slice("campaign:".length), type: "campaign" } as RecordData)
        : undefined),
  );
  if (camps.some((c) => !c)) throw Error("Choose campaigns from this snapshot");
  const st = camps.map((c) =>
    stats(
      c!.id,
      metrics.filter((m) => text(m.campaignId) === c!.id),
      fromBounces,
      bad.has(c!.id),
    ),
  );
  const rr = st.map(statRates);
  const caveats: string[] = [];
  const attr = (k: string) =>
    new Set(camps.map((c) => lower(c![k]) || "unspecified"));
  if (attr("objective").size > 1)
    caveats.push(
      "Objectives differ: " + [...attr("objective")].join(" vs ") + ".",
    );
  if (attr("campaignType").size > 1)
    caveats.push(
      "Campaign types differ: " + [...attr("campaignType")].join(" vs ") + ".",
    );
  if (attr("channel").size > 1) caveats.push("Channels differ.");
  const durations = st.map(
    (s) => (Date.parse(s.periodEnd) - Date.parse(s.periodStart)) / DAY + 1,
  );
  if (Math.max(...durations) > 2 * Math.min(...durations))
    caveats.push("Measurement periods differ by more than 2×.");
  const vols = st.map((s) => s.sends?.toNumber() || 0);
  if (Math.min(...vols) === 0 || Math.max(...vols) > 10 * Math.min(...vols))
    caveats.push("Send volumes differ by more than 10× or are missing.");
  if (st.some((s) => s.overlap))
    caveats.push(
      "At least one campaign has overlapping metric periods; its totals are withheld.",
    );
  if (
    st.some(
      (s) =>
        Date.parse(s.periodEnd + "T23:59:59Z") >
        Date.parse(meta.asOf) - lookback * DAY,
    )
  )
    caveats.push(
      "At least one campaign is still accruing engagement (within the look-back window).",
    );
  if (st.some((s) => s.openBasisRaw))
    caveats.push("Open-based rates are not bot-filtered.");
  let test: CompareResult["test"] = null;
  if (
    st.length === 2 &&
    st.every(
      (s) =>
        s.uniqueClicks &&
        s.delivered &&
        s.sends &&
        s.sends.gte(minSends) &&
        !s.overlap,
    )
  ) {
    const t = twoProportion(
      st[0].uniqueClicks!.toNumber(),
      st[0].delivered!.toNumber(),
      st[1].uniqueClicks!.toNumber(),
      st[1].delivered!.toNumber(),
    )!;
    test = {
      metric: "Unique clickthrough rate",
      method:
        "Two-sided pooled two-proportion z-test; assumes independent recipients and comparable audiences",
      diffPp: Number(t.diffPp.toFixed(3)),
      pValue: Number(t.pValue.toPrecision(3)),
      conclusion: caveats.length
        ? "No winner declared: the campaigns are not comparable on the listed points."
        : t.pValue < 0.05
          ? "The difference is unlikely to be chance alone at the 5% level. It does not show what caused the difference."
          : "No winner declared: the difference is within what chance can produce.",
    };
  } else
    caveats.push(
      "No statistical test: needs exactly two campaigns with delivered, unique clicks and at least the minimum sends.",
    );
  const row = (metric: string, unit: string, vals: (Decimal | null)[]) => ({
    metric,
    unit,
    values: vals.map(fmt),
  });
  return {
    columns: camps.map((c) => ({
      key: "campaign:" + c!.id,
      label: text(c!.name) || c!.id,
    })),
    rows: [
      {
        metric: "Objective",
        unit: "text",
        values: camps.map((c) => text(c!.objective) || null),
      },
      {
        metric: "Period",
        unit: "text",
        values: st.map((s) =>
          s.periodStart ? s.periodStart + " – " + s.periodEnd : null,
        ),
      },
      row(
        "Sends",
        "count",
        st.map((s) => s.sends),
      ),
      row(
        "Delivered",
        "count",
        st.map((s) => (s.overlap ? null : s.delivered)),
      ),
      row(
        "Bounce rate",
        "percent",
        rr.map((r) => r.bounce),
      ),
      row(
        "Unique open rate",
        "percent",
        rr.map((r) => r.open),
      ),
      row(
        "Unique clickthrough rate",
        "percent",
        rr.map((r) => r.click),
      ),
      row(
        "Click-to-open rate",
        "percent",
        rr.map((r) => r.ctor),
      ),
      row(
        "Unsubscribe rate",
        "percent",
        rr.map((r) => r.unsub),
      ),
      row(
        "Form submissions (source)",
        "count",
        st.map((s) => s.forms),
      ),
      ...pipelineRows(
        source,
        all,
        camps.map((c) => c!.id),
        caveats,
      ),
    ],
    caveats,
    test,
  };
}

/** Leads, opportunities and won revenue per compared campaign, as recorded (never causal). */
function pipelineRows(
  source: Source,
  all: RecordData[],
  ids: string[],
  caveats: string[],
) {
  const leads = all.filter((r) => r.type === "lead"),
    opps = all.filter((r) => r.type === "opportunity");
  if (!leads.length && !opps.length) return [];
  caveats.push(
    "Leads, opportunities and revenue use the campaign recorded on each lead or opportunity; they are not adjusted for audience size and do not show cause.",
  );
  const mine = (rows: RecordData[], id: string) =>
    rows.filter((r) => text(r.campaignId) === id);
  const wonSum = (id: string) => {
    const won = mine(opps, id).filter(
      (o) =>
        lower(o.outcome) === "won" &&
        (!present(o.currency) ||
          text(o.currency).toUpperCase() === source.currency),
    );
    return won.every((o) => D(o.amount) !== null)
      ? won.reduce((s, o) => s.plus(D(o.amount)!), new Decimal(0))
      : null;
  };
  return [
    {
      metric: "Leads (as recorded)",
      unit: "count",
      values: ids.map((id) =>
        leads.length ? String(mine(leads, id).length) : null,
      ),
    },
    {
      metric: "Opportunities (as recorded)",
      unit: "count",
      values: ids.map((id) =>
        opps.length ? String(mine(opps, id).length) : null,
      ),
    },
    {
      metric: `Won revenue (${source.currency}, as recorded)`,
      unit: "money",
      values: ids.map((id) => (opps.length ? fmt(wonSum(id)) : null)),
    },
  ];
}

const finding = (r: Report, id?: string) =>
  r.findings.find((f) => f.id === id) || r.findings[0];
export const eloqua: ModuleDefinition = {
  app: "eloqua",
  definitionVersion: VERSION,
  layout: ELOQUA_LAYOUT,
  rules: ELOQUA_RULES,
  metricDictionary: ELOQUA_METRICS,
  assess,
  select,
  validateBatch,
  scenarioFields: [
    {
      key: "delivered",
      label: "Delivered emails (measured)",
      unit: "count",
      prefill: "delivered",
    },
    {
      key: "baselineClickRate",
      label: "Baseline unique click rate (%)",
      unit: "percent",
      prefill: "unique_click_rate",
    },
    {
      key: "proposedClickRate",
      label: "Assumed click rate after change (%)",
      unit: "percent",
    },
    {
      key: "clickToFormRate",
      label: "Assumed click-to-form rate (%)",
      unit: "percent",
      prefill: "click_to_form",
      optional: true,
    },
    {
      key: "formToOpportunityRate",
      label: "Assumed form submitter → opportunity rate (%)",
      unit: "percent",
      prefill: "lead_to_opportunity",
      optional: true,
    },
    {
      key: "winRate",
      label: "Assumed win rate (%)",
      unit: "percent",
      prefill: "win_rate",
      optional: true,
    },
    {
      key: "avgDeal",
      label: "Assumed average deal value",
      unit: "money",
      prefill: "avg_won_deal",
      optional: true,
    },
  ],
  simulate,
  compare,
  compareEntity: "campaign",
  analyzeEntity: "campaign",
  draftTypes: [
    {
      id: "campaign_brief",
      label: "Campaign review brief",
      fields: [
        { key: "issue", label: "Observed issue", multiline: true },
        { key: "evidence", label: "Supporting evidence", multiline: true },
        {
          key: "explanations",
          label: "Plausible explanations (hypotheses)",
          multiline: true,
        },
        {
          key: "investigation",
          label: "Recommended investigation",
          multiline: true,
        },
        { key: "action", label: "Proposed action", multiline: true },
        { key: "success", label: "Success measure" },
      ],
      prefill: (r, id) => {
        const f = finding(r, id);
        return f
          ? {
              issue: f.title + ". " + f.detail,
              evidence:
                (f.evidenceIds.join(", ") || "See report") +
                " · " +
                r.definitionVersion,
              explanations: (f.recommendation?.hypotheses || []).join("\n"),
              investigation: (
                ELOQUA_RULES[f.rule.replace(/-v\d+$/, "")]?.nextChecks || []
              ).join("\n"),
              action: f.action,
              success: f.recommendation?.measurement || "",
            }
          : {
              issue: "",
              evidence: "",
              explanations: "",
              investigation: "",
              action: "",
              success: "",
            };
      },
    },
    {
      id: "experiment_plan",
      label: "Experiment plan (A/B test)",
      fields: [
        { key: "hypothesis", label: "Hypothesis", multiline: true },
        { key: "treatment", label: "Treatment vs control", multiline: true },
        { key: "primaryMetric", label: "Primary metric" },
        { key: "guardrails", label: "Guardrail metrics" },
        { key: "population", label: "Target population" },
        { key: "sampleSize", label: "Sample size (use the calculator)" },
      ],
      prefill: (r, id) => {
        const f = finding(r, id);
        const click = r.metrics.find((m) => m.id === "unique_click_rate");
        return {
          hypothesis: f
            ? `If we address “${f.title}”, the unique clickthrough rate will change.`
            : "",
          treatment:
            "Control: current email. Treatment: one changed element (e.g. call to action).",
          primaryMetric: "Unique clickthrough rate (recipient-level)",
          guardrails: "Unsubscribe rate, bounce rate",
          population: "Recipients of the next comparable send, randomly split",
          sampleSize: click?.value
            ? `Baseline ${click.value}% — enter the smallest change worth detecting in the calculator.`
            : "Enter baseline and minimum detectable effect in the calculator.",
        };
      },
    },
    {
      id: "email_copy",
      label: "Email / landing page copy draft",
      fields: [
        { key: "subject", label: "Subject line" },
        { key: "preheader", label: "Preheader" },
        { key: "body", label: "Body copy", multiline: true },
        { key: "cta", label: "Call to action" },
        {
          key: "notes",
          label: "Brand and personalization notes",
          multiline: true,
        },
      ],
      prefill: () => ({
        subject: "",
        preheader: "",
        body: "",
        cta: "",
        notes:
          "Use only approved brand material and fields with verified coverage.",
      }),
    },
    {
      id: "nurture_outline",
      label: "Nurture outline",
      fields: [
        { key: "entry", label: "Entry criteria", multiline: true },
        { key: "steps", label: "Steps (one per line)", multiline: true },
        { key: "exit", label: "Exit criteria", multiline: true },
        { key: "measures", label: "Measures" },
      ],
      prefill: () => ({
        entry: "",
        steps: "",
        exit: "",
        measures: "Step progression from step-membership history",
      }),
    },
  ],
};
