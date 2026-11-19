# Go-live checklist (evidence required at each step)

| # | Step | Evidence to record | Status in this build |
|---|---|---|---|
| 1 | Separate managed PostgreSQL; `db:migrate`; runtime role non-owner, NOBYPASSRLS | `npm run verify:production` output; `npm run test:postgres` against a fresh test DB | Passed on local PostgreSQL 16 only |
| 2 | OIDC login, logout, expiry, unverified email, no-membership user | Test log per case | Not verified (no IdP) |
| 3 | Deploy web and worker behind TLS; health checks; logs | Deployment record, `/health/ready` | Not verified |
| 4 | Eloqua: discovery, test, sync, reconcile one campaign against the native report | Counts and differences, recorded in the connection's evidence | Not verified |
| 5 | Unity: auth, resources, complete membership export, readiness on a known audience | Counts vs Unity UI | Not verified |
| 6 | Infinity: export (no repeated refresh), or Streams with gap handling; reconcile one day | Counts vs native report | Not verified |
| 7 | AI: live structured response, fallback cases, budget | Model, date, transcript | Not verified (no key) |
| 8 | Permissions: owner/analyst/viewer, restricted source, revocation | Test log | Automated tests pass locally |
| 9 | Failure recovery: 401/403/429/5xx, expired token, cancellation, worker restart | Job history | Contract-tested; not live |
| 10 | Backup and restore drill on the managed service | Row counts, policies, RLS test on restore | Passed locally only |
| 11 | Preservation check | `node preservation/verify-responsys.mjs` PASS | PASS |
