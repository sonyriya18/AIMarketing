# Implementation status

Status vocabulary follows blueprint §21.2. Each feature lists its strongest evidence. A passing
contract test is not a live connection; a missing credential blocks live verification only.
Last updated: 2026-10-16.

## Summary

| Area | Status | Evidence |
|---|---|---|
| Config validation and production refusals | `verified_local` | `tests/integration/foundation.test.ts` |
| PostgreSQL schema, RLS, non-owner runtime role | `verified_local` | foundation tests run as `rci_app` (NOBYPASSRLS) |
| Sessions, CSRF, logout revocation | `verified_local` | foundation tests |
| Development identity harness (refused in production) | `verified_local` | foundation tests |
| OIDC login (PKCE) | `implemented_unverified` | no identity provider available in this environment |
| Roles, grants, membership changes take effect immediately | `verified_local` | foundation tests (T54) |
| Tenant isolation (API + DB) | `verified_local` | foundation tests with two users and direct SQL as `rci_app` |
| Append-only audit history | `verified_local` | foundation tests |
| Durable job queue (lease, retry, dead letter) | `verified_local` | imports/work integration tests |
| Private file storage (filesystem driver) | `verified_local` | import tests; object-store driver `not_started` |
| CSV import: campaign-metrics format | `verified_local` | `tests/integration/imports-reports.test.ts`, e2e |
| CSV import: legacy account summary format | `verified_local` | imports-reports tests (summary-only facts, no invented campaigns) |
| Duplicate detection, rollback, version activation | `verified_local` | imports-reports tests |
| Metric registry + exact decimal math | `verified_local` | `tests/unit/metrics.test.ts` (golden fixture) |
| Account-timezone periods (DST-safe, injected clock) | `verified_local` | `tests/unit/periods.test.ts` |
| Report snapshots (overview, campaign, comparison) | `verified_local` | imports-reports tests, e2e |
| Exports: CSV / JSON / Markdown from snapshot | `verified_local` | imports-reports tests, security tests (formula safety) |
| Export: PDF from snapshot (client-side) | `verified_local` | builds and opens from Save Report; content not machine-asserted |
| SSE live updates + polling fallback | `verified_local` | work tests; footer shows "Live updates connected" in e2e |
| Responsys login + endpoint allow-list | `verified_contract` | `tests/contract/responsys.test.ts` |
| Responsys Connect job-run sync | `verified_contract` | contract tests |
| Responsys async performance reporting | `verified_contract` (request/poll) | unknown result row shapes are rejected, not guessed |
| Responsys live read | `blocked_external` | no Responsys account credentials provided |
| Connect job triggering | `blocked_external` | event-feed jobs 422; others 503 until entitlement is verified |
| Grounded AI chat (Gemini adapter) | `verified_local` with fake provider | `tests/integration/work.test.ts`; live Gemini call `blocked_external` (no key) |
| Rule-based answers when AI is off | `verified_local` | work tests, e2e |
| AI page summaries (Summary, Analyze, Compare, Simulator) | `verified_local` with fake provider | `tests/integration/summary.test.ts`, e2e; live Gemini `implemented_unverified` |
| Content (subject line, creative type) and offer breakdowns | `verified_local` | imports-reports tests, e2e screenshots |
| Email template builder (fields, in-preview edit, RPL, export, save) | `verified_local` | e2e journey |
| NVIDIA (OpenAI-compatible) provider, Gemini → NVIDIA backup | `verified_local` with stubbed HTTP | `tests/unit/ai-provider.test.ts`; live call `blocked_external` (no key, host blocked here) |
| Scenario planner (assumption-based) | `verified_local` | work tests, e2e |
| Drafts with versions + optimistic concurrency | `verified_local` | work tests, e2e |
| Approvals with separation of duties | `verified_local` | work tests |
| External actions (provider drafts, proofs, sends) | `blocked_external` | always recorded as `blocked`; kill switches default off; no verified write capability |
| CED / SFTP file ingestion | `not_started` | needs SFTP host and file spec |
| Browser journey (upload → draft) | `verified_local` | `tests/e2e/journey.spec.ts` (Playwright, Chromium), through the original five pages |
| Original UI structure (5 tabs, names, design) | `verified_local` | D13; screenshots compared with the reference zip |
| Production build excludes fixtures/dev middleware | `verified_local` | `npm run verify:no-demo` |
| Netlify adapter (function proxy, Blobs, cron, polling) | `verified_local` | `tests/integration/netlify-handler.test.ts`; bundled with Netlify's bundler and smoke-tested end to end |
| Managed DB mode (owner login + `SET LOCAL ROLE rci_app`) | `verified_local` | `tests/integration/managed-db.test.ts` + full suite on a fresh non-superuser-owned Postgres 16 |
| Sign-in allow-list | `verified_local` | security tests |
| Netlify deployment | see `docs/VERIFICATION.md` (deploy entry) | live checks need Google sign-in configured by the owner |
| Google sign-in (OIDC) live | `blocked_external` | owner must create the Google OAuth client (`docs/DEPLOY_NETLIFY.md`) |
| Container image / compose / CI | `not_started` | |

## Remaining work (next gates)

1. Owner completes Google sign-in setup on Netlify, then verify the deployed journey.
2. Container image, compose file and CI pipeline (M9).
3. Live Responsys read verification once credentials and reporting entitlement are provided
   (see `RESPONSYS_SETUP.md`).
4. Confirm the async reporting result row schema against a real response, then enable it.
5. CED/SFTP ingestion if the account uses it.
6. OIDC verification against the chosen identity provider.
