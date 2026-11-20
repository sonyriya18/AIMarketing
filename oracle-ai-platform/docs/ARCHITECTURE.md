# Architecture, module matrices and build plan

> **Update (2026-11-19).** `responsys/` now holds the supplied Responsys Windows release, unchanged (see `docs/RESPONSYS_SSO.md`). The platform adds **client branding** per company (`workspaces.brand`, schema version 4, additive): logos, display name, colour, official websites, the client's own Oracle login addresses, context facts with sources and marketing rules. The Provider console edits it (**Branding & links**) or pre-fills it from a client template (`shared/clients.ts`: Endeavour Group). The AI receives the facts as a "business profile" document (context only, never results) and the rules as a binding "marketing rules" document. Branding never grants access: applications still come from the subscription and each member's app list. On Windows, `2-START.cmd` runs `server/local.ts` with the bundled Node.js and serves the prebuilt `dist` screens. Responsys opens without its own first-run screens: after single sign-on the platform prepares the person's Responsys session through Responsys's own API (`server/responsys-link.ts`, schema version 5 adds `responsys_workspace_id` and `responsys_account_id`).

## 1. Read-only design reference: the protected Responsys app (`responsys/`)

The new platform reuses the *idea* and visual family of the user's Responsys app. It does not import, wrap or proxy it.

| Responsys pattern (read-only) | Reused as an idea in the new platform |
|---|---|
| `src/components/Header.tsx`: Summary · AI Simulator · Analyze Campaign · Compare Campaigns · Ask AI | The same five-tab primary navigation, with app-specific labels |
| `ExecutiveBriefing.tsx`, `AiSummary.tsx` | Summary: KPI cards, ranked recommendations, sections, limitations |
| `WhatIfSimulator.tsx` (assumption-based, measured inputs prefilled) | AI Simulator: measured vs assumed vs projected, persisted with formula version |
| `SingleCampaignAnalysis.tsx` | Analyze: scoped assessment of one campaign / audience / journey |
| `ComparativeBattlecard.tsx` | Compare: side-by-side with comparability caveats and a documented test |
| `AnalystChat.tsx` (grounded, cites evidence) | Ask {App} AI: grounded statements with metric/finding/playbook/tool citations |
| `UploadExport.tsx`, `features/data` (import + validation reasons) | Upload: typed validation, row/file errors, explicit batch, partial quarantine |
| `features/drafts`, `CampaignBuilder.tsx` | Draft studio: domain drafts with revisions and approvals (no publishing) |
| `shared/contracts`, `server/modules/reports` (versioned report snapshots) | Immutable report snapshots with definition versions and provenance |

The user-supplied archive's known SHA-256 (`bd5c8b…da26`) cannot be checked here because the archive itself was not supplied in this session. The protected copy is the user-approved working Responsys lineage (Responsys plus three later commits), and its differences from the 23 Oct archive baseline are listed by `node preservation/verify-responsys.mjs --archive`.

## 2. Separation and protection boundary

```
┌──────────── oracle-ai-platform/ (one folder) ────────────┐
│ responsys/        protected Responsys (byte-identical, hash-checked; own package.json, DB)
│ preservation/     verify-responsys.mjs + RESPONSYS_BASELINE.json (outside the protected tree)
│ windows/          1-SETUP.cmd / 2-START.cmd scripts
│ server/ src/ …    the platform: own package.json/lockfile, DB, worker, tests
└──────────────────────────────────────────────────────────┘
```

- No file is written inside `responsys/`. No shared imports, dependencies, middleware, CSS or database; the platform only starts Responsys and forwards `responsys.localhost` requests to it.
- The "Oracle Responsys" card opens the unmodified Responsys app (the company's own address, else `RESPONSYS_URL`) in a new tab, with no iframe.
  - With `RESPONSYS_SSO_SECRET` set, Responsys signs in through the platform's OIDC provider (`/sso`). The provider issues a code only for subscribed companies and only to that company's registered Responsys address (`docs/RESPONSYS_SSO.md`).
  - Without it, Responsys keeps its own sign-in.
  - If no address is set, the card says so.
- The preservation check fails on any added, removed, renamed or changed file and refuses to regenerate its own baseline.

## 3. Runtime architecture

```
Browser (React/Vite)  ──HTTPS──>  Express API (server/app.ts + routes-*.ts)
                                   │  auth.ts: OIDC (prod) / dev login (dev only), sessions, CSRF, origin,
                                   │           workspace → entitlement → user app grant → source grant → role/permission
                                   │  modules/{eloqua,unity,infinity}.ts  ← product-owned entities, metrics, rules,
                                   │                                         scenarios, comparisons, draft types
                                   │  modules/common.ts  ← evidence contract (Metric, Finding, Recommendation, Section)
                                   │  ai.ts  ← provider adapter (Gemini / OpenAI-compatible), validation, tools
                                   │  context.ts/outcomes.ts ← report snapshots, outcome tracking
                                   ▼
                                PostgreSQL (separate DB; RLS by workspace; non-owner runtime role)
                                   ▲
Worker (server/worker.ts) ─────────┘  durable jobs (leases, attempt fencing, retries, checkpoints),
                                      Eloqua Bulk lifecycle, Infinity export/stream, scheduled digests
Oracle APIs ◄── secureRequest (approved hosts only, DNS-pinned, no redirects, size-bounded)
```

Contracts: `ModuleDefinition` (server/modules/types.ts), `Source`, `Capability`, `DatasetVersion` (datasets table + metadata), `MetricDefinition`, `Report` (evidence snapshot), `Finding` + `Recommendation`, `ScenarioResult`, `DraftType`/drafts, actions (ActionPlan with baseline/outcome), investigations, jobs (SyncJob), audit.

Local development uses embedded PGlite in `.data/` (durable on disk). Production uses managed PostgreSQL, a separate migration role and a non-owner runtime role (`npm run db:migrate`). The worker must run as a persistent process (not a short-lived function).

## 4. Screen / module matrix

| | Eloqua | Unity | Infinity |
|---|---|---|---|
| Summary | Portfolio sends/delivered/rates (aggregated numerators/denominators), campaign table, click chart, nurture structure, asset readiness, ranked backlog, capability checklist | Records vs masters, link coverage, required-field completeness, consent states by channel/purpose, audience readiness, job health, remediation queue | Report-mode sessions/conversion (never mixed with events), event sessions/conversion, ordered funnel, tracking quality, daily volume + anomaly, cohorts |
| AI Simulator | Click-rate / click-to-form scenario; A/B sample-size calculator | Readiness after field completion / consent verification (no double counting) | Conversion-rate scenario with optional user value + currency; sample size |
| Analyze | Analyze Campaign / Nurture: campaign-scoped metrics, assets, steps, progression | Analyze Data / Audience: segment readiness + blockers; field completeness by source system | Analyze Journey: user-chosen ordered steps, window, session/visitor identity |
| Compare | Compare Campaigns: objective/type/channel/duration/volume/maturity caveats; two-proportion test only when comparable | Compare Audiences: readiness side by side; exact overlap (∩, ∩/|A|, ∩/|B|, Jaccard) only for complete, compatible memberships | Compare Journeys / Cohorts: report or event cohorts; overlap detection; test only for disjoint cohorts |
| Ask AI | Ask Eloqua AI | Ask Unity AI | Ask Infinity AI |
| Drafts | Campaign review brief, experiment plan, email/landing copy, nurture outline | Audience definition (typed, allowlisted), remediation plan, activation checklist | Journey investigation brief, tracking repair checklist, experiment brief |

Every module also has Data & connections, Reports, Action plans, Drafts, Investigations and Notifications, plus a context strip (source, dataset, period, timezone, data age, coverage).

## 5. Automation matrix

| Manual task | Data required | Calculation (code) | AI contribution | Output | Level | Acceptance test |
|---|---|---|---|---|---|---|
| Assemble campaign performance | campaign_metrics | Σ numerators / Σ denominators, overlap withholding | Explains, cites metric IDs | Summary + campaign table | A | modules: aggregates, overlaps |
| Find delivery/engagement exceptions | campaign_metrics, activity | Threshold rules with min volume, maturity | Hypotheses (labeled) | Ranked backlog | A | modules + API |
| Reconcile activity to sends | activity, campaign | Unmatched/immature detection | — | Finding + checklist | A | modules: unmatched, immature |
| Review nurture flow | step, step_membership | Reachability, dead ends, progression | — | Nurture table + findings | A | modules: nurture |
| Check asset readiness | asset (+contact) | HTML/metadata/merge-field checks | Draft copy fixes | Readiness table | A/B | modules + e2e |
| Data-quality investigation | profile | Completeness by field/source, staleness, link coverage | Hypotheses, remediation draft | Remediation queue, draft | A/B | modules + API |
| Activation readiness | segment, membership, destination, consent | Record-level blockers | Checklist draft | Readiness + blockers | A/B | modules readiness |
| Audience overlap | complete memberships | Exact set math with compatibility gates | — | Overlap metrics | A | modules overlap |
| Draft an audience | profile fields | Type/operator validation; local preview count | NL → typed definition | Draft (not published) | B | API audience validate |
| Journey drop-off | event + steps/window | Ordered funnel | Investigation brief | Funnel + finding | A/B | modules funnel, e2e |
| Tracking QA | event + tracking_spec | Missing attributes, unknown events, duplicates, late | Repair checklist | Tracking section | A/B | modules tracking |
| Volume anomaly | ≥ minHistoryDays events | z-score vs trailing days | — | Finding or "insufficient history" | A | modules anomaly |
| Follow-through | finding | Baseline + re-evaluation on new snapshot | — | Outcome ("no longer observed") | B | API outcome |
| Weekly review | active dataset | Scheduled assessment, diff vs last digest | — | Digest + notifications | A | API digest |
| Publishing / sending / activating in Oracle | — | — | — | Not implemented (disabled) | C | none: no write adapters |

A = authorized routine automation · B = reviewed internal work · C = Oracle/business write (not implemented; interfaces only described).

## 6. Capability matrix

| Capability | Status |
|---|---|
| Eloqua: Advanced Intelligence (fatigue, send-time optimization, account engagement, generative content) | Confirmed native Oracle capability (subscription-dependent); not re-implemented or claimed as a gap. The platform's exposure flag is rule-based and labeled separately. |
| Unity: identity resolution, Customer 360, intelligent attributes, segments | Native Oracle; read/assessed only. No identity rules, merges or activations are performed. |
| Infinity: analytics, actions, recommendations | Native Oracle (subscription-dependent); the platform assesses exported reports/events and drafts investigations. |
| Upload-based assessment for all three | Implemented and tested locally |
| Eloqua Bulk activity + campaign metadata adapter | Implemented, contract-tested with simulated responses; **not live verified** |
| Eloqua Reporting API | Not implemented: needs the tenant's subject areas and reconciliation target |
| Unity read adapter | Generic, administrator-configured REST resources (tenant paths/mapping); IDCS password grant documented by Oracle supported; **not live verified**; SFTP multipart exports not implemented |
| Infinity saved-report export / Streams | Implemented (no repeated refresh; gap-aware stream window); **not live verified** |
| OIDC SSO, managed PostgreSQL, hosted deployment | Implemented/configured paths; **not verified in a customer environment** |
| Generative AI (Gemini) | Implemented, contract-tested with simulated responses; **live response not verified** (no key in this session) |
| Oracle write actions (publish, send, activate, change rules) | Not implemented by design (level C) |
| Genuinely missing customer inputs | See `CUSTOMER_SETUP_CHECKLIST.md` |

## 7. Build order and first journeys (as delivered)

1. Preservation guard and separate project (done).
2. Shared foundation: identity, workspaces, entitlements, roles/permissions, sources, evidence contracts, imports (done).
3. Eloqua upload → assessment → analyze → compare → scenario → AI/fallback → draft → report → action (done, browser-tested).
4. Unity and Infinity equivalents with their own rules, batch validation and data-mode distinctions (done, browser-tested).
5. Investigations, playbooks, schedules/digests, outcomes, feedback, cross-app evidence (done).
6. Live connector configuration and reconciliation with customer access (pending customer inputs).

First journey per app (browser test `tests/e2e/workspace.spec.ts`): sign in → choose the entitled app and source → upload the export batch → Summary → inspect evidence → Analyze → Compare → Simulate → Ask AI (rule-based fallback without a key) → save draft/report/action → reload → verify persistence.
