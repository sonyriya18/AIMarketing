# Implementation decisions

1. **Separate sibling project.** `oracle-ai-platform/` reuses the tested foundation of the earlier enterprise-ai package (auth, RLS, jobs, security, AI adapter). Sales and Commerce were removed from the registry, schema, fixtures and navigation; Eloqua is new. The protected `AIMarketing/` is never written.
2. **Protected copy is the user's working Responsys lineage** (Responsys plus the Gemini/Connect, converter and credential-message commits), as instructed. Its differences from the original 23 Oct archive baseline are reported, never reset.
3. **Product modules own their domain.** `server/modules/{eloqua,unity,infinity}.ts` each define entities, metric dictionary, rules (with versions), scenario formula, comparison and draft types. A shared `Assessment` builder enforces the evidence contract and the published priority order: severity, then affected volume, then evidence completeness. There is no opaque score.
4. **One report per view, immutable.** Every assessment is stored with dataset, definitions, thresholds, capabilities and provenance. Retention expires unsaved, unreferenced views.
5. **Batch imports.** Related files are validated together (cross-file duplicates, referential links) and become one snapshot. Partial snapshots need an explicit reason and are labeled everywhere.
6. **Unity overlap** is exact only for complete memberships at the same identity level within a snapshot tolerance. Otherwise it is unavailable with the reason.
7. **Infinity data modes stay separate.** Report totals never create a funnel; events never add to report sessions.
8. **Eloqua timestamps** need an explicit instance offset; the adapter refuses to guess.
9. **AI**: Gemini first, with structured JSON output and allowlisted server tools. Digits are banned in model prose so numbers always come from code. Causal wording is allowed only in statements labeled hypotheses.
10. **No PDF parsing or server PDF rendering**: playbooks are text or Markdown, and reports offer a labeled browser print view.
11. **Browser polling** is used for job status, not SSE. It is labeled as polling, and source freshness is shown as the data's as-of time.
12. **No Oracle write adapters** (automation level C). Approvals are platform records only.
13. **Provider-controlled subscriptions (2 Nov 2026).** Company administrators can no longer change their own tools. A provider role (from configuration; the first local sign-in in development) owns company creation and subscriptions. Suspension hides every tool without deleting data.
14. **Responsys stays unchanged and joins through single sign-on.** The platform is a minimal OIDC provider (code + PKCE S256, RS256 ID tokens, one confidential client). Responsys already supports OIDC sign-in, so only its local settings change. A code is issued only for the user's current company, if it subscribes to Responsys, and only to that company's registered Responsys address. The subscription is checked again at token time. Rejected alternatives:
    - re-implementing Responsys inside the platform (it would no longer be Responsys);
    - a reverse proxy (Responsys uses root paths and its own sessions);
    - a link with Responsys's own sign-in (no subscription control).
15. **Eloqua lead stages come only from customer milestone dates** (`mqlAt`, `salAt`, `sqlAt`, `convertedAt`, `disqualifiedAt`):
    - Stage conversion uses mature leads only (`leadMaturityDays`).
    - A stage whose dates are absent from the export is unavailable, not zero.
    - Campaign revenue is attribution "as recorded" on the lead or opportunity, never a modelled multi-touch split.
    - Opportunity amounts in another currency are excluded, never converted.
16. **Infinity time on page** is the time to the next page view in the same session:
    - The last page of a session is unmeasured and reported as a coverage share.
    - Sessions with one hit, or with a gap above `sessionTimeoutMinutes`, have no measurable duration; they are counted as unmeasured, not zero.
    - Saved page reports are summed per page; overlapping rows are withheld; distinct visitor counts are never added.
17. **Single-page share is named "single-page sessions (bounce)"** and documented as possibly differing from Infinity's own bounce definition.
18. **Dashboards over long pages (4 Nov 2026).**
    - Each module declares a layout (topic groups, a plain-language "about" for every section, rule → topic and capability → topic maps). The engine output stays the same; the layout is applied after assessment.
    - Charts are engine-computed sections (`kind: "chart"`) drawn with recharts, the library Responsys uses.
    - Categorical colours follow a validated fixed order and fold into "Other" beyond six categories; there is no dual axis.
    - Every chart has a table view.
19. **AI evidence includes views, with label masking.**
    - The model now sees chart and table data (bounded), so it can explain trends and breakdowns.
    - Aggregated labels (page paths, campaign and source names) are needed for useful answers and were already present in finding text.
    - URL query strings and fragments are removed, and email addresses and long digit runs are masked, before anything is sent.
    - Raw records are never sent.
20. **AI insights are cached** per dataset, definition version, period, scope, options, provider and model; only AI-generated answers are cached.
21. **One-click sample data is development-only**, clearly labelled synthetic, and sets sample settings only where the source has none.
22. **Responsys opens reliably from the platform (local, 4 Nov 2026).**
    - The Responsys folder next to the platform is found even before it is set up, so a click on Oracle Responsys names the missing step (not installed, no database settings, PostgreSQL stopped, wrong password, port in use) instead of "address not set".
    - The launch waits up to 20 seconds while Responsys starts. The new tab is opened during the click, so pop-up blockers allow it, and it is closed again on an error.
    - Local sign-in subjects come from the email (`local-` + SHA-256), so a reinstalled platform signs in to the same Responsys user. At start, the platform clears Responsys sign-in links from earlier local installs (same local issuer, older random subjects). Responsys users, workspaces and data are unchanged, and production keeps the platform user id as the subject.
23. **One folder (4 Nov 2026).** At the owner's request, Responsys moved into the platform folder as `responsys/`. Its files are unchanged (preservation check PASS). The platform excludes it from type checks, tests, formatting, the Vite watcher and the container image, and finds it there automatically. The older sibling layout (`../AIMarketing`) still works.
24. **ChatGPT request settings (10 Nov 2026).** Current OpenAI models, including reasoning models, accept `max_completion_tokens` and only the default temperature, and JSON mode requires the word "JSON" in the messages. Calls to api.openai.com now send `max_completion_tokens` (at least 16,000, because reasoning models spend part of it thinking) and no temperature, and every prompt asks for one JSON object. Other OpenAI-compatible servers keep `max_tokens` and `temperature`; when a provider names a setting it does not support, the call retries once without it. Key, quota, model and rate-limit errors are shown in plain words, never with the key. The setup script sets `AI_TIMEOUT_MS=90000` for ChatGPT.
25. **Simpler workspace navigation.** Action plans, Drafts, Investigations and Reports are grouped under one "Follow-up" button with tabs; no feature was removed. Daily values are drawn as trend lines, small charts keep labels readable, count axes use whole numbers, and measured simulator inputs show at most two decimals.
26. **Office networks (10 Nov 2026).** Office laptops often inspect secure traffic with a company certificate that browsers trust but Node.js does not, or allow internet only through a proxy. `2-START.cmd` now enables Node's `--use-system-ca` (Windows certificate store) when the installed Node supports it, and uses the Windows proxy setting as `HTTPS_PROXY` when one is set. The platform's pinned-address requests tunnel through an `http://` proxy (HTTP CONNECT; TLS still verifies the real host; only approved hosts), and Responsys gets the same settings with `NODE_USE_ENV_PROXY` while its sign-in calls to localhost stay direct. Connection failures now name the cause (certificate, DNS, firewall, proxy, timeout). `3-CHECK-AI.cmd` / `npm run ai:check` tests the configured AI from the PC.
27. **Responsys-style screens for Eloqua, Unity and Infinity (10 Nov 2026).** A studio service computes per-entity measures (numerators and denominators, never averaged rates) and flows from the snapshot. Deep dives compare an entity with the median of the others in its group ("account pattern", at least two). Head-to-head names a side ahead only when both values exist, the direction is clear and each rate rests on at least 100 people or visits. Builders save platform drafts only; nothing is published to Oracle. Customer profile lookups are exact-match and audited.
28. **Email preview safety.** Export HTML is untrusted: it is shown in a sandboxed frame with no scripts and a content policy that blocks remote images (tracking pixels) until the user ticks "Load images".
29. **Responsys inside the platform window.** Locally the gateway lets only the platform origin frame Responsys (frame-ancestors) and marks Responsys's cookies SameSite=None; Secure; Partitioned, because localhost and responsys.localhost are different sites to the browser. Responsys code is unchanged and still checks its own CSRF token. Without the gateway (production), Responsys opens in the same window at the company's address.
30. **Only necessary items.** The "Combined evidence" card was removed from the home page.
