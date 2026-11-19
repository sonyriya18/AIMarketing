# Verification record

Commands actually run, their outcomes, and evidence. Newest entries are appended at the end
of each section. Environment: Linux container, Node v22.22.0, npm 10.9.4, PostgreSQL 16.15.

## M0 — Baseline of the supplied archive (2026-10-15)

| Command | Result |
|---|---|
| `npm ci` (original manifest) | **Failed**: ERESOLVE — `vite@8.3.4` peerOptional `esbuild@^0.27 \|\| ^0.28` vs root `esbuild@^0.25.0` |
| `npm install --save-dev esbuild@^0.28.2` then `npm ci` | Passed, 0 vulnerabilities reported |
| `npx tsc --noEmit` (original `lint`) | Passed (exit 0) — non-strict, frontend-oriented config; not a backend check |
| `npm run build` (original `vite build`) | Passed; single 1.6 MB JS chunk; frontend bundle only |

Runtime probes against the original `server.ts` (`PORT=3999 npx tsx server.ts`):

| Probe | Observed | Audit item |
|---|---|---|
| `GET /api/campaigns` | Returns fixture Amil campaigns on first start | A01 |
| `POST /api/analyze {"campaignId":"does-not-exist"}` | Returns a report for the first fixture campaign (no 404) | T35 |
| `POST /api/summary {"period":"7d"}` | "Last 7 days (Sep 24 – Sep 30, 2026)" although today is 2026-10-15 | A04 |
| `POST /api/summary` custom range 2020-01-01..2020-01-02 | 0 campaigns but **1,000,000 sent and 350,000 revenue** | A05 |

## M1–M9 — Rebuilt application (2026-10-15)

Local services: PostgreSQL 16 (`rci_test` database, runtime role `rci_app`), Chromium for Playwright.

| Command | Result |
|---|---|
| `npm run typecheck` (browser + strict server configs) | Passed (exit 0) |
| `npx vitest run` | Passed — 7 files, 97 tests (unit 24, integration 53, contract 12, security 8) |
| `npm run test:security` | Passed — 8 tests |
| `PW_CHROMIUM_PATH=… npx playwright test` | Passed — 1 journey (upload → validation → summary 28.00% / +3.00 pp / $9,500.00 → inspect → CSV export → campaign → compare → scenario → ask → draft saved as version 1) |
| `npm run build` | Passed — Vite frontend + esbuild server bundles |
| `npm run verify:no-demo` | Passed — browser (2503 modules), API (48), worker (21): no fixtures, mock analytics or dev middleware |

Screenshots from the journey are written to `test-results/screens/` (not committed).

### Not verified

- Live Responsys read (no credentials) — `blocked_external`.
- Live Gemini call (no API key) — AI paths tested with an in-process fake provider only.
- OIDC sign-in against a real identity provider.
- Container build and deployment (not yet implemented).

## Netlify adaptation (2026-10-15)

| Command / check | Result |
|---|---|
| `npm run typecheck` | Passed |
| `npx vitest run` (local Postgres, runtime login `rci_app`) | Passed — 11 files, 105 tests, 4 skipped (managed-DB file needs its URL) |
| Fresh Postgres 16 cluster, DB owned by non-superuser `dbowner` (CREATEROLE), `TEST_OWNER_ROLE_MODE_URL=…` `npx vitest run` | Passed — 10 files, 104 tests (whole suite through `SET LOCAL ROLE rci_app`, incl. tenant isolation) |
| Bug found by that run | PG16 gives a role's creator ADMIN but not SET; fixed by `GRANT … WITH SET TRUE, INHERIT FALSE` |
| `npx @netlify/zip-it-and-ship-it netlify/functions` | Bundled `api` (route `/api/*`) and `jobs-cron` (`*/5 * * * *`) |
| Bundled `api.mjs` smoke test (fresh managed DB + local Netlify Blobs server) | ready 200 · sign-in · workspace · upload to Blobs · validate · commit · job drained via waitUntil → completed · overview total open rate 28 · SSE 503 in poll mode |
| `npm run verify:no-demo` | Passed — now also checks both Netlify functions |
| Playwright journey | Passed |

## Original-design rebuild (2026-10-16)

| Command / check | Result |
|---|---|
| `npm run typecheck` | Passed |
| `npx vitest run` | Passed — 11 files, 114 tests, 4 skipped (managed-DB file) — includes program/weekday breakdowns on the golden fixture, new period presets, exports for campaign and comparison reports |
| Playwright journey (Summary upload → exact figures → evidence → Save Report CSV → Analyze Campaign → Compare VS 2 / VS Multiple → AI Simulator save scenario → Create campaign draft v1 → Ask AI) | Passed |
| `npm run verify:no-demo` | Passed (browser, API, worker, both Netlify functions) |
| `npm run build` | Passed |
| Visual comparison with the reference zip (screenshots of all five pages) | Layout, names and section order match; unavailable sections are labelled instead of filled |

## Fix: blank page after the redesign deploy (2026-10-16)

Cause: report snapshots were reused by request + data revision + definition version; snapshots
saved by the previous release lacked `byProgram`/`byWeekday`, and the new Summary crashed reading
them. Fix: `REPORT_FORMAT_VERSION` is part of the snapshot key; the Summary tolerates missing
sections; a screen-level error boundary shows the error instead of a blank page.

| Check | Result |
|---|---|
| Regression test "never serves a snapshot saved in an older format" | Fails without the fix (stale snapshot served), passes with it |
| `npx vitest run` | Passed — 115 tests, 4 skipped |
| Playwright journey | Passed |
| `npm run typecheck`, `npm run verify:no-demo`, `npm run build` | Passed |

## AI summaries, content/offer data, Ask AI crash, email builder (2026-10-16)

Ask AI crash ("l is not a function", reported on Edge): the chat's scroll effect returned the
result of `scrollIntoView()`, which newer Chromium/Edge return as a Promise; React then called it
as the effect cleanup when the chat changed. Effects now use block bodies.

| Check | Result |
|---|---|
| Reproduction (production build, `scrollIntoView` returning a Promise, switch campaign on Ask AI) | Fails before the fix, passes after |
| `npx vitest run` | Passed — 12 files, 120 tests, 4 skipped (managed-DB file) — adds AI summary tests (fact checks, rejection of invented numbers/causes, cache, tenant isolation, AI failure fallback, campaign/comparison/simulator views) and exact subject/creative/offer grouping |
| Same suite in owner-login + `SET ROLE` mode (`TEST_OWNER_ROLE_MODE_URL`) | Passed — 124 tests |
| Playwright journey | Passed — now also: Promise-returning `scrollIntoView`, campaign switch on Ask AI, AI summary labels, email subject/field edit, in-preview edit, RPL view without locking the visual editor, `.htm` download name |
| `npm run typecheck`, `npm run verify:no-demo`, `npm run build` | Passed |
| Live Gemini call | Not verified here (no key in this environment); fake provider only |

## Live AI failure diagnosis and fix (2026-10-16)

| Check | Result |
|---|---|
| Netlify function logs (observability API) | Every chat/summary call failed: Google 404 "models/gemini-2.5-flash is no longer available to new users … use models/gemini-3.8-flash"; the builder's AI proposals failed the same way (503 in the app) |
| `tests/unit/ai-provider.test.ts` (stubbed client) | Passed — Gemini 3+ gets thinking level LOW and no temperature; 2.5 Flash gets budget 0; one retry without options on 400; retired-model, key, quota, timeout and empty-answer messages |
| `npx vitest run` | Passed — 13 files, 127 tests, 4 skipped; adds AI status check and summary `aiError` |
| Same suite in owner-login + `SET ROLE` mode | Passed — 131 tests |
| Playwright journey, `npm run typecheck`, `npm run verify:no-demo`, `npm run build` | Passed |
| Live call with `gemini-3.8-flash` | Not verified here (no key in this environment); verify with the footer "AI" badge after deploy |

## Free-tier quota and overload handling (2026-10-16)

| Check | Result |
|---|---|
| Live logs after switching to `gemini-3.8-flash` | Calls reached Google; failures were 429 (free tier 5 requests/minute) and 503 (high demand) |
| `npx vitest run` | Passed — 129 tests, 4 skipped (adds 503 retry, 429 message, one call per page, status without spending a request) |
| Owner-login + `SET ROLE` mode | Passed — 133 tests |
| Playwright journey, `npm run verify:no-demo`, `npm run build` | Passed |
| Live AI answer | Not verified here (no key); confirm via the footer "AI: working" after a page summary |

## Simulator review fixes (2026-10-22)

| Check | Result |
|---|---|
| `tests/contract/responsys.test.ts` | Passed — a Connect run on the day after the period is excluded with `toExclusive`; `to` stays inclusive |
| `tests/integration/summary.test.ts` | Passed — the simulator brief returns an AI strategy pick in its single request; unknown key, causal reason, unknown fact id and invented number are each rejected; page summaries do not ask for a pick |
| `tests/integration/work.test.ts` | Passed — Ask AI uses the scenario as labelled assumption facts only for the same report, rule-based answers mark them as hypotheses, unknown fields are refused; launch counts are per period with dataset history kept; the simulator plan is stored on the draft |
| Playwright journey | Passed — rule-based strategy label without AI, opt-out checkbox changes the audience, the builder opens on the template picked in the simulator, Ask AI shows and answers about the scenario |
| Live AI strategy pick | Not verified here (no key in this environment); check the "Why the AI picked …" line on the simulator with a working key |
