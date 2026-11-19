# Implementation plan

Source of truth for the specification: `RESPONSYS_PRODUCTION_BLUEPRINT.md`.
This file tracks milestones, dependencies, and acceptance gates. Status lives in
`IMPLEMENTATION_STATUS.md`; evidence lives in `VERIFICATION.md`.

## M0 baseline: source and feature map (supplied archive)

Active import graph (from `src/main.tsx`):

```
App.tsx
 ├─ data/campaigns.ts  (MOCK_CAMPAIGNS, PRECOMPUTED_REPORTS, computeAccountPeriodReport,
 │                      getPresetPeriodDateRange — fixed Sep-2026 dates)
 │    ├─ data/connectJobMetrics.ts (fixed Amil job runs, ignores period)
 │    └─ data/problemStrategyEngine.ts (fixed thresholds/benchmarks)
 ├─ Header.tsx                      (fixed 2026-04-01..2026-09-30 date defaults)
 ├─ ExecutiveBriefing.tsx           (fallback KPI literals 24.2%, 5.8%, 98.6%..., fixed channel split 65/20/15,
 │    └─ RecommendationPlaybook ─ data/whatIfEngine.ts ─ data/campaigns.ts, data/amilTemplates.ts)
 ├─ SingleCampaignAnalysis.tsx      (receives fixture Campaign, unweighted averages, morning-send heuristics,
 │                                   data/strategies.ts)
 ├─ ComparativeBattlecard.tsx       (fixture campaigns, utils/pdfReport.ts)
 ├─ WhatIfSimulator.tsx             (whatIfEngine: invented audience sizes, segment multipliers, "confidence" slider)
 │    ├─ ProgramFlowDiagram.tsx
 │    ├─ CampaignBuilder.tsx ─ utils/rplEngine.ts, utils/refineEngine.ts (/api/ai/prompt), data/amilTemplates.ts
 │    └─ TemplatePreviews.tsx
 ├─ AnalystChat.tsx                 (/api/chat; hardcoded morning-send/fatigue fallback text on error)
 ├─ NewCampaignModal.tsx            (local "ingest" into in-memory store, utils/campaignValidator.ts)
 ├─ ExportModal.tsx ─ utils/pdfReport.ts (exports recompute from fixture campaigns, not the displayed report)
 └─ UploadExport.tsx                (/api/upload-export → single global in-memory export)
```

Not in the active graph (legacy): `CounterfactualSimulator.tsx` (4,372 lines),
`ConnectedStrategyWorkflow.tsx`, `ResponsysWorkflowVisualizer.tsx`,
`data/marketingStrategies.ts`, `data/campaignConcepts.ts` (imported only by `server.ts`).

Every visible KPI in the baseline traces to `src/data/campaigns.ts` fixtures, except the
Summary tab while a CSV upload is active (KPIs from the file, merged over a fixture-derived
base report — audit A08). Baseline runtime evidence is in `VERIFICATION.md`.

## Target architecture (summary)

- `server/` modular Express API (`/api/v1`), app factory, zod-validated config.
- PostgreSQL 16 via `pg`, plain SQL migrations, owner/runtime role split, RLS on all
  tenant tables, composite tenant foreign keys, append-only audit.
- Durable PostgreSQL job table (lease + heartbeat + attempts + dead letter) and a separate
  worker process; events table for SSE replay.
- Server sessions (HttpOnly cookie, hashed token, CSRF header); OIDC (openid-client, PKCE)
  for real identity; a development/test-only identity harness that config validation
  refuses in production.
- Filesystem object storage behind a storage interface.
- Deterministic analytics with `decimal.js`, metric registry, IANA-timezone period service,
  immutable report snapshots shared by screens, chat, scenarios, and exports.
- Optional Gemini adapter behind an AI provider interface; core analytics never require it.
- Responsys adapter (server-only) contract-tested against a local test HTTP server.
- React/Vite frontend kept, re-wired to typed query hooks (`@tanstack/react-query`).

## Milestones and gates

| Milestone | Scope | Gate |
|---|---|---|
| M0 | Baseline, graph, ledger, first regression tests | Baseline recorded; fabrication paths covered by tests |
| M1 | Config, DB, roles/RLS, sessions, auth, RBAC, storage, jobs, health | Two workspaces isolated; restart persists; empty workspace has no activity |
| M2 | CSV import wizard (legacy summary + campaign-level), validation, activation, duplicates, rollback | Real file → exact figures; reload/restart safe; malformed file cannot produce a dashboard |
| M3 | Metric registry, periods, snapshots, campaign/comparison reports, screen + export migration | Golden fixture agrees across overview/detail/comparison/export |
| M4 | Responsys read adapter, capabilities, reporting partitions/polling, Connect | Contract/failure tests pass; live verification recorded as blocked without credentials |
| M5 | SSE + polling fallback, freshness, scheduled sync | Revision reaches UI; freshness distinct from connectivity |
| M6 | Evidence packages, Gemini adapter, validation, persisted chat | Core analytics work with AI off; invented evidence rejected |
| M7 | Deterministic scenarios, low/base/high, sensitivity | Identical inputs → identical outputs; projections labeled |
| M8 | Draft versions, validation, approvals, kill switches, external operations | Edits invalidate approvals; disabled switches reject in UI and API |
| M9 | E2E, security tests, builds, container, verify scripts, runbooks | Section 21 gates with evidence |

Dependencies: M1 → M2 → M3 → (M4, M6, M7, M8) → M5 → M9.
