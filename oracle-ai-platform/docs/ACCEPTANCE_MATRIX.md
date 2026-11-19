# Acceptance matrix (prompt section 15)

Legend: **Local** = automated test run in this build (embedded PostgreSQL unless noted) · **PG** = also run on real PostgreSQL 16 as a non-owner runtime role · **Contract** = simulated provider responses · **Live** = real customer system.

| ID | Requirement | Evidence | Level |
|---|---|---|---|
| P1 | Responsys files unchanged, nothing added | `node preservation/verify-responsys.mjs` → PASS, 161 files | Local |
| P2 | Responsys v17 opens through platform single sign-on only for subscribed companies; unconfigured state disclosed | sso.test (contract, openid-client 6.8.8 as in v17); api.test launcher; live local run with the real v17 | Local + live local (no deployment) |
| P3 | Provider controls subscriptions; companies see exactly 1/2/3/4 subscribed tools; dates and suspension apply; company admins cannot change tools | api.test "Client subscriptions"; e2e companies.spec | Local + PostgreSQL runtime role |
| P4 | Eloqua leads, sales, events, website; Infinity website performance and time spent | modules.test (exact numbers); e2e Eloqua and Infinity journeys | Local (synthetic data only) |
| U1 | Different entitlements → different apps; no API/URL bypass | api.test "shows each company…", "cannot bypass…" | Local + PG |
| U2 | Same-app sources isolated; switching resets context | api.test restricted source; App resets on source change; e2e | Local + PG |
| U3 | No dev login in production; admin/analyst/viewer and approvals | security-imports.test; api.test permissions; draft separation of duties; e2e viewer | Local |
| U4 | Distinct views/calculations; actions persist; errors shown | modules.test; e2e three journeys | Local |
| D1 | Valid upload → assessment; malformed → row/file errors | api.test imports; security-imports.test | Local + PG |
| D2 | Batch identities/links; duplicates; overlapping aggregates | security-imports.test batch; modules.test overlap withholding; idempotent re-import | Local |
| D3 | Denominators, unique vs total, null vs zero, pp change, timezone, provenance | modules.test shared + per app | Local |
| D4 | Eloqua delayed activity, recipient vs message, unmatched, missing CRM, nurture validity | modules.test Eloqua | Local |
| D5 | Unity source/master, consent, complete vs partial membership, overlap formulas, stale, readiness limits | modules.test Unity | Local |
| D6 | Infinity ordered sequences, out-of-order/repeats, windows, report totals ≠ funnel, distinct counts, anomaly history | modules.test Infinity | Local |
| D7 | Reports/scenarios/drafts/actions survive reload and new snapshots | api.test persistence; e2e reload checks | Local + PG |
| C1 | Auth, token renewal, 401/403/404/429/5xx, pagination, async states, invalid shapes | connectors.test | Contract |
| C2 | Infinity export polling never restarts; stream gaps visible, no replay claims | connectors.test; streams.ts coverage notes | Contract |
| C3 | Durable jobs: leases, attempt fencing, cancellation, checkpoint resume without duplicate exports | jobs.ts fencing; connectors.test Eloqua resume | Contract (worker crash not simulated end-to-end) |
| C4 | Live reconciliation | — | **Not done: no customer access** |
| A1 | AI success, missing key, timeout, invalid schema, fabricated refs, provider failure, truncation | connectors.test AI | Contract |
| A2 | No cross-source tool access; injected instructions grant nothing; numbers from verified metrics | api-ai.test; validateAnswer digit ban | Local (simulated provider) |
| A3 | Revocation applies to reports, AI, jobs | api.test entitlement revocation; worker re-checks membership/entitlement each run | Local |
| A4 | SSRF, secret redaction, upload validation, escaping, formula injection, deletion, non-owner DB | security-imports.test; api.test deletion; postgres-rls.test | Local + PG |
| A5 | Rules-only mode distinct; hypotheses/scenarios never facts | UI badges; validateAnswer; scenario notes; e2e checks label | Local |
| B1 | Browser journey per app | tests/e2e/workspace.spec.ts + companies.spec.ts (8 scenarios, incl. AI home page and four client companies) | Local (Chromium) |
| B2 | Inaccessible apps, empty data, mobile, keyboard | e2e viewer, mobile overflow, keyboard nav | Local (failed-sync and stale-data UI states are shown by the code but not exercised in e2e) |
| B3 | Strict types, tests, build | typecheck, 98 tests (+26 on PG), build | Local |
| B4 | Production identity, DB permissions, worker, monitoring, backup restore in real deployment | Local PostgreSQL migration + RLS + restore drill only | **Not done in a deployment** |
| B5 | Final preservation check; list live-verified integrations | PASS; none live-verified | Local |
