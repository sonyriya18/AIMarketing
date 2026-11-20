// Product registry and shared evidence contracts for the Oracle AI Assessment Platform.
// Only Eloqua, Unity and Infinity are assessment modules. Responsys is the unmodified Responsys
// application, opened through platform sign-in (single sign-on) when the company subscribes to it.
export const APP_IDS = ["eloqua", "unity", "infinity"] as const;
export type AppId = (typeof APP_IDS)[number];
export type ProductId = AppId | "responsys";
export const PRODUCT_IDS: ProductId[] = [
  "responsys",
  "eloqua",
  "unity",
  "infinity",
];
// Stored role names. "owner" is shown as Administrator in the interface.
export type Role = "viewer" | "analyst" | "owner";
export const ROLE_LABEL: Record<Role, string> = {
  owner: "Administrator",
  analyst: "Analyst",
  viewer: "Viewer",
};
// Explicit permissions that an administrator can grant to an analyst. Administrators have all.
export const PERMISSIONS = ["connectors", "approvals"] as const;
export type Permission = (typeof PERMISSIONS)[number];
export type Tab =
  | "summary"
  | "analyze"
  | "compare"
  | "simulator"
  | "chat"
  | "builder"
  | "data"
  | "reports"
  | "actions"
  | "drafts"
  | "investigations"
  | "notifications"
  | "settings";
export interface Product {
  id: ProductId;
  name: string;
  short: string;
  description: string;
  summary: string;
  analyze: string;
  compare: string;
  ask: string;
  entity: string;
}
export const PRODUCTS: Product[] = [
  {
    id: "responsys",
    name: "Oracle Responsys",
    short: "Responsys",
    description:
      "Campaigns, email performance, AI simulator and campaign builder",
    summary: "",
    analyze: "",
    compare: "",
    ask: "",
    entity: "",
  },
  {
    id: "eloqua",
    name: "Oracle Eloqua",
    short: "Eloqua",
    description: "Campaigns, leads, sales pipeline, events and website",
    summary: "Campaigns, leads, pipeline, events and website",
    analyze: "Analyze Campaign / Nurture",
    compare: "Compare Campaigns",
    ask: "Ask Eloqua AI",
    entity: "campaign",
  },
  {
    id: "unity",
    name: "Oracle Unity Customer Data Platform",
    short: "Unity",
    description: "Customer data quality, identity and audience readiness",
    summary: "Customer data quality and audience readiness",
    analyze: "Analyze Data / Audience",
    compare: "Compare Audiences",
    ask: "Ask Unity AI",
    entity: "segment",
  },
  {
    id: "infinity",
    name: "Oracle Infinity",
    short: "Infinity",
    description: "Website performance, time spent, journeys and tracking",
    summary: "Website performance, time spent, journeys and tracking",
    analyze: "Analyze Journey",
    compare: "Compare Journeys / Cohorts",
    ask: "Ask Infinity AI",
    entity: "cohort",
  },
];
/** What each topic of an assessment shows, and which export unlocks it. */
export const TOPICS: Record<
  AppId,
  { name: string; shows: string; needs: string }[]
> = {
  eloqua: [
    {
      name: "Campaigns",
      shows: "Delivery, opens, clicks and unsubscribes per campaign and month",
      needs: "campaign + campaign_metrics (activity optional)",
    },
    {
      name: "Leads",
      shows:
        "Lead funnel MQL → SAL → SQL → opportunity, waiting MQLs, best sources",
      needs: "lead (with milestone dates)",
    },
    {
      name: "Sales",
      shows:
        "Open pipeline, won revenue, win rate, deal size and revenue by campaign",
      needs: "opportunity (CRM export)",
    },
    {
      name: "Events",
      shows: "Registrations, attendance, no-shows and attendee pipeline",
      needs: "marketing_event + event_registrant",
    },
    {
      name: "Website",
      shows: "Visits, known visitors, landing pages and visit time",
      needs: "site_visit",
    },
    {
      name: "Nurture & assets",
      shows: "Nurture step progression and email asset checks",
      needs: "step, step_membership, asset",
    },
  ],
  infinity: [
    {
      name: "Website",
      shows:
        "Bounce, exit, time on page per page; time spent per session; devices",
      needs: "event (with page and sessionId) or page_metrics",
    },
    {
      name: "Traffic",
      shows: "Sessions per day, channels and cohorts",
      needs: "event, or report_manifest + report_row",
    },
    {
      name: "Journeys",
      shows: "Ordered funnel with the biggest drop-off",
      needs: "event with sessionId + funnel steps",
    },
    {
      name: "Tracking",
      shows: "Missing attributes, unknown and duplicate events, anomalies",
      needs: "tracking_spec + event",
    },
  ],
  unity: [
    {
      name: "Customers",
      shows: "Source systems, identity links and customer attributes",
      needs: "profile",
    },
    {
      name: "Data quality",
      shows: "Field completeness and freshness",
      needs: "profile (+ required fields)",
    },
    {
      name: "Consent",
      shows: "Granted, denied, expired and unknown consent per channel",
      needs: "consent",
    },
    {
      name: "Audiences",
      shows: "Members ready to activate and what blocks the rest",
      needs: "segment, membership, destination",
    },
    {
      name: "Jobs",
      shows: "Job runs, failures and last success",
      needs: "job",
    },
  ],
};
export const product = (id: string) => PRODUCTS.find((p) => p.id === id)!;
export const isApp = (id: string): id is AppId => APP_IDS.includes(id as AppId);
export const ENTITY_TYPES: Record<AppId, string[]> = {
  eloqua: [
    "campaign",
    "asset",
    "campaign_metrics",
    "activity",
    "contact",
    "step",
    "step_membership",
    "lead",
    "opportunity",
    "marketing_event",
    "event_registrant",
    "site_visit",
  ],
  unity: ["profile", "consent", "segment", "membership", "destination", "job"],
  infinity: [
    "report_manifest",
    "report_row",
    "page_metrics",
    "event",
    "tracking_spec",
  ],
};
export const QUESTIONS: Record<AppId, string[]> = {
  eloqua: [
    "Which comparable campaigns need review this week?",
    "Where did this nurture lose engagement?",
    "What evidence supports changing this form?",
    "Which exports would make this assessment stronger?",
    "Which lead sources turn into pipeline, and where do MQLs stall?",
    "Which events had low attendance and what should we do next time?",
    "Which landing pages lose visitors fastest?",
  ],
  unity: [
    "Why is this audience not ready for its destination?",
    "Which required fields are least complete?",
    "How much do these two fully exported audiences overlap?",
    "Which job failures need attention first?",
  ],
  infinity: [
    "Which step has the largest measured drop-off?",
    "Is the apparent decline consistent with a tracking gap?",
    "Which cohorts differ, and how comparable are they?",
    "Create an investigation plan without claiming the cause is proven.",
    "Which pages keep visitors longest, and which lose them on arrival?",
    "How does time spent differ between mobile and desktop?",
  ],
};
export interface RecordData {
  id: string;
  type: string;
  [key: string]: unknown;
}
// Observed: calculated from sufficient evidence. Unavailable: required inputs missing.
// Partial: calculated from incomplete coverage. Not applicable: the measure does not apply.
export type MetricState =
  "observed" | "unavailable" | "partial" | "not_applicable";
export interface Metric {
  id: string;
  label: string;
  value: string | null;
  unit: "count" | "percent" | "money" | "days" | "seconds" | "pp" | "text";
  currency?: string;
  formula: string;
  reason?: string;
  recordIds: string[];
  state?: MetricState;
  grain?: string;
  basis?: "unique" | "total" | "snapshot" | "derived";
  version?: string;
}
export type Severity = "high" | "medium" | "low" | "info";
export interface Recommendation {
  action: string;
  rationale: string;
  hypotheses: string[];
  dataNeeded: string[];
  ownerRole: string;
  effort: string;
  targetMetric: string | null;
  automation: "A" | "B" | "C";
  permission: string;
  measurement: string;
  uncertainty: string;
}
export interface Finding {
  id: string;
  /** Dashboard topic, e.g. "Leads" or "Website". */
  group?: string;
  app?: AppId;
  title: string;
  severity: Severity | "attention";
  detail: string;
  evidenceIds: string[];
  recordIds: string[];
  action: string;
  rule: string;
  entityScope?: string;
  caveats?: string[];
  priority?: { rank: number; basis: string; affected: number };
  recommendation?: Recommendation;
}
/** A chart drawn from exact values computed by the module (never by the AI). */
export interface ChartSpec {
  type: "line" | "area" | "bar" | "hbar" | "stacked" | "grouped" | "donut";
  /** Key of the category / x value in each data row. */
  x: string;
  series: { key: string; label: string }[];
  data: Record<string, string | number | null>[];
  unit?: Metric["unit"];
  /** Area charts: stack the series (only when they are parts of one whole). */
  stacked?: boolean;
}
export interface Section {
  id: string;
  kind: "table" | "bars" | "funnel" | "checklist" | "timeline" | "chart";
  title: string;
  subtitle?: string;
  /** Plain-language "what this shows and how to use it". */
  about?: string;
  chart?: ChartSpec;
  /** Dashboard group the section belongs to (e.g. "Leads", "Website"). */
  group?: string;
  columns?: { key: string; label: string; unit?: Metric["unit"] }[];
  rows?: Record<string, unknown>[];
  items?: {
    label: string;
    state: "available" | "partial" | "unavailable" | "ok" | "issue";
    detail: string;
  }[];
  bars?: { label: string; value: number | null; note?: string }[];
  unit?: Metric["unit"];
  note?: string;
}
export interface Capability {
  id: string;
  group?: string;
  label: string;
  state: "available" | "partial" | "unavailable";
  needs: string;
}
export interface Report {
  id: string;
  app: AppId;
  name: string;
  datasetId: string;
  sourceId: string;
  sourceMode: string;
  generatedAt: string;
  asOf: string;
  timezone: string;
  currency: string;
  metrics: Metric[];
  findings: Finding[];
  warnings: string[];
  records: RecordData[];
  definitionVersion: string;
  sections?: Section[];
  /** Dashboard topics in display order (after "Overview"). */
  groups?: string[];
  capabilities?: Capability[];
  thresholds?: Record<string, unknown>;
  options?: Record<string, unknown>;
  comparisons?: unknown;
  period?: { start: string | null; end: string | null };
  policy?: Record<string, unknown>;
  sourceMetadata?: Record<string, unknown>;
  scope?: string[];
  candidates?: {
    analyze: { key: string; label: string }[];
    compare: { key: string; label: string }[];
    eventNames?: string[];
    fields?: string[];
  };
}
export interface Source {
  id: string;
  app: AppId;
  name: string;
  timezone: string;
  currency: string;
  policy: Record<string, unknown>;
  visibility: string;
  environment?: string;
}
export interface Session {
  user: { id: string; email: string };
  /** Platform provider administrator: manages client companies and their subscriptions. */
  provider: boolean;
  workspace: {
    id: string;
    name: string;
    slug: string;
    logo: string | null;
    brand?: import("./clients").Brand;
    status: "active" | "suspended";
    role: Role;
    permissions: Permission[];
  } | null;
  workspaces: { id: string; name: string; slug?: string; role: Role }[];
  products: ProductId[];
  csrf: string;
  mode: string;
  /** Responsys opens through platform single sign-on. */
  responsysSso: boolean;
  /** Responsys runs behind this platform, so it opens inside the platform window. */
  responsysEmbedded: boolean;
}

/* ---------------- Studio: deep dives, head-to-head and flows (all apps) ---------------- */
export interface StudioMetric {
  id: string;
  label: string;
  unit: Metric["unit"];
  /** Which direction is better, when it is clear; null = no judgement. */
  better: "higher" | "lower" | null;
  /** How the value is calculated (shown under the value). */
  formula: string;
}
export interface FlowNode {
  id: string;
  label: string;
  column: number;
  value: number;
}
export interface FlowLink {
  from: string;
  to: string;
  value: number;
}
export interface Flow {
  columns: string[];
  nodes: FlowNode[];
  links: FlowLink[];
  unit: string;
  note?: string;
}
export interface StudioEntity {
  key: string;
  label: string;
  /** Benchmark group: an entity is compared with others in the same group. */
  group: string;
  tags: string[];
  values: Record<string, number | null>;
  /** Denominator behind each rate, so small samples are flagged. */
  sample: Record<string, number | null>;
  trend?: ChartSpec & { title: string };
  flow?: Flow & { title: string };
  related?: { title: string; items: { label: string; detail?: string }[] }[];
  /** Scope key for a scoped assessment (findings) of this entity. */
  scopeKey?: string;
  /** Email content from the export (untrusted HTML: shown only in a locked-down frame). */
  previews?: { name: string; subject: string; html: string }[];
}
export interface Studio {
  app: AppId;
  entityLabel: string;
  entityPlural: string;
  groups: { id: string; label: string }[];
  metrics: StudioMetric[];
  /** The metrics shown first in cards and tables. */
  headline: string[];
  entities: StudioEntity[];
  flows: { id: string; title: string; about: string; flow: Flow }[];
  currency: string;
  asOf: string;
  datasetId: string;
  notes: string[];
}
