# Decision log

Material architectural decisions and approved deviations from the blueprint defaults.

## D01 — npm is the canonical package manager; `bun.lock` removed
The archive shipped both `package-lock.json` and `bun.lock`. npm is kept (blueprint 5.1);
`bun.lock` is deleted to avoid two dependency histories.

## D02 — esbuild devDependency raised from ^0.25 to ^0.28.2
Baseline `npm ci` failed with ERESOLVE: `vite@8.3.4` declares
`peerOptional esbuild@"^0.27.0 || ^0.28.0"` while the root pinned `esbuild@^0.25.0`.
Raising the devDependency within the range Vite supports is the minimal non-destructive fix
(no `--force`, no `--legacy-peer-deps`).

## D03 — Plain SQL migrations with `pg` instead of Drizzle
The blueprint allows "Drizzle and `pg`, or an existing validated SQL layer". Plain SQL keeps
RLS policies, roles, grants, composite foreign keys, and SECURITY DEFINER functions explicit
and reviewable in one place. A small runner (`server/db/migrate.ts`) applies files in order
inside transactions and records them in `schema_migrations` with a checksum; a changed
applied file fails the run.

## D04 — PostgreSQL job queue instead of BullMQ/Redis
The blueprint default is BullMQ + Redis with PostgreSQL as the durable record. At the current
scale the durable record and the execution queue are the same PostgreSQL table
(`jobs`), claimed with `FOR UPDATE SKIP LOCKED`, with leases, heartbeats, bounded attempts,
exponential backoff with jitter, and a dead-letter state. This removes a second stateful
dependency and the Redis-loss recovery problem while keeping idempotent, restartable workers.
Revisit if measured queue throughput requires it. Redis is not required to run the app.

## D05 — Wide fact tables for observed measures
Instead of one EAV `metric_observations` table, observed measures are stored in two typed fact
tables that match the two supported grains:
- `summary_window_facts` — legacy account-period CSV rows (declared snapshot windows).
- `campaign_launch_facts` — campaign/launch rows, optionally daily.

Each measure column is nullable (blank stays NULL; zero stays 0), `NUMERIC` (exact), and each
row keeps the import, dataset version, source row number, and currency. Metric semantics live
in the metric registry (`shared/metrics`), not in column names alone. This keeps aggregation
in SQL simple and exact while preserving null/coverage information (`COUNT(col)` vs `COUNT(*)`).

## D06 — Server sessions + CSRF header; OIDC for real identity; dev harness for local/test
Sessions are opaque random tokens in an HttpOnly cookie; the database stores only a SHA-256
hash. Writes require an `X-CSRF-Token` header bound to the session. OIDC Authorization Code +
PKCE uses `openid-client`. A local identity harness (`AUTH_MODE=dev`) exists for development and
automated tests only; configuration validation refuses to start with it when
`NODE_ENV=production` or `APP_DATA_MODE=production`. No universal password exists.

## D07 — One explicit data source per report
Uploaded summaries, campaign files, and provider reporting snapshots are alternate
representations of activity. A report scope names exactly one dataset (and therefore one active
version). Datasets are never summed together. Source selection is explicit in the UI.

## D08 — Legacy summary CSV requires declared semantics at import
The legacy file does not state its as-of date, window inclusivity, timezone, currency, or whether
"Open Rate"/"Click-Through Rate" are total or unique. The import wizard requires these as explicit
mapping confirmations. Rates without numerators stay source rates; counts are never reconstructed
from rounded rates unless a future explicit "estimated" option is enabled (not implemented).

## D09 — Synchronous small exports, client-rendered PDF from the snapshot
CSV/JSON/Markdown exports stream from an immutable report snapshot. PDF is rendered in the
browser with the existing jsPDF dependency from the same snapshot payload (no headless browser,
no remote asset loading), so the export can never take a different analysis path.

## D10 — Business-specific templates become a selectable example content pack
The Amil Dental templates are kept as an explicitly selected "example pack" for the creative
builder. A neutral starter pack is the default, and brand values (name, domain, sender) come from
account settings. No account receives Amil branding unless it selects that pack.

## D11 — Gemini stays the runtime AI adapter; configured model only
`AI_PROVIDER=none` is the default. When `AI_PROVIDER=gemini`, `AI_MODEL` must be set; there is
no hidden fallback model list. Calls use the SDK's abort signal for cancellation.

## D12 — Netlify hosting: one function, managed Postgres with SET ROLE, Blobs, polling
Chosen by the owner (all on Netlify, Google sign-in). The Express app is unchanged and runs
inside one Netlify Function (`/api/*`) on a loopback port; the platform's client IP replaces any
caller-supplied forwarding header. Netlify Database provides a single owner login, so the app
creates the non-owner role `rci_app` and every transaction runs `SET LOCAL ROLE rci_app`
(`DATABASE_RUNTIME_ROLE`); RLS applies exactly as with a separate login, and the whole
integration suite passes in this mode against a fresh non-superuser-owned database. Migrations
are embedded in the bundle and applied at cold start in one transaction under an advisory lock
(safe behind a transaction pooler and concurrent instances). The session secret is generated
inside the database (owner-only table), so no secret is pasted anywhere. Uploads use Netlify
Blobs with strong consistency. Jobs run after successful writes (`waitUntil`, 40 s budget) and
every 5 minutes (scheduled function); long-lived SSE is replaced by 5-second polling
(`LIVE_UPDATES=poll`). Upload limit is 4 MB (platform request limit). Startup refuses until a
sign-in allow-list (`ALLOWED_SIGNIN_EMAILS`) is set, so a public URL cannot be used by strangers.
Tradeoff: an application SQL injection could `RESET ROLE`; all queries are parameterized and
the role switch is centralized in `Db.transaction()`.

## D13 — Screens follow the original app's structure and naming
At the owner's request the UI uses the original app's five tabs and names — Summary, AI Simulator,
Analyze Campaign, Compare Campaigns (VS 2 / VS Multiple), Ask AI — with the original header,
"Active Analysis Mode" bar, numbered sections and visual design (components ExecutiveBriefing,
WhatIfSimulator, SingleCampaignAnalysis, ComparativeBattlecard, AnalystChat, NewCampaignModal,
ExportModal, RecommendationPlaybook). Every field is bound to report snapshots or the scenario
engine. Sections whose data a campaign file cannot contain (hourly velocity, link placement,
mailbox providers, creative and offer performance, segments) keep their place and say what is
missing. Data upload sits on Summary ("Upload an export", as in the earlier version), with data
sources and the Responsys connection in "Data & connections". Server additions: program and
weekday breakdowns in the overview snapshot; 60-day and 6/12/24/36-month presets matching the
original period menu. Recommendations are deterministic (rules version recs-2026-10-16.1) and
never promise revenue; the simulator's estimates come from planning-scenario-2026-10-15.1.

## D14 — AI summaries rephrase deterministic facts; numbers are checked
The owner asked for AI-summarized output on every page. `POST /reports/:id/summary` builds
"facts" — sentences formatted from the authorized snapshot (`server/modules/insights/summary.ts`,
prompt `page-summary-2026-10-16.1`) — and asks the configured model to write short sections
(Summary: executive + each numbered section + next best actions; Analyze; Compare; Simulator
brief). Each point must cite fact IDs, may only contain numbers that appear in those facts, and
may not claim causes; failing points are dropped and a section with none falls back to rule-based
text from the same facts. Every section is labelled AI or Rule-based. Fully AI-written results
are cached per immutable snapshot (`report_ai_summaries`, RLS), so a page spends AI budget once.
Metrics, recommendations and scenario outputs remain deterministic.

## D15 — Serverless AI time budget
Netlify synchronous functions stop after about 10 s. On Netlify `AI_TIMEOUT_MS` defaults to
8000 so an AI call gives up in time and the request returns its labelled rule-based answer; page
summaries are split into parallel calls of at most four sections; Gemini 2.5 Flash models run
with thinking turned off (`thinkingBudget: 0`) because these answers only rephrase supplied
facts. `AI_MAX_OUTPUT_TOKENS` default is 8192 (a cap, not a cost).

## D16 — Optional Creative Type and Offer columns
Campaign files may carry `Creative Type` and `Offer` (with aliases, see DATA_DICTIONARY). They are
stored as written on each fact row (migration 003) and grouped in the overview snapshot together
with Subject Line (`bySubjectLine`, `byCreativeType`, `byOffer`), feeding Summary sections 6 and 8.
Rows without a value are reported as "not given", never assigned a value.

## D17 — Model-aware Gemini settings, readable failures, real AI check
Live logs on 2026-10-16 showed every AI call failing with Google's 404 "models/gemini-2.5-flash is
no longer available to new users … use models/gemini-3.8-flash". The adapter now: sends a low
thinking level and no sampling settings to Gemini 3+ models (zero thinking budget on 2.5 Flash);
retries once without optional settings if Google rejects them (HTTP 400); turns provider errors
into plain messages (model unavailable, key refused, quota, timeout) that are shown where the
rule-based fallback appears (summary cards, Ask AI, builder). `GET /ai/status` makes one tiny
model call and the footer shows "AI: connected (model)" only after it succeeds — otherwise the
reason. No automatic switch to another model (D11: no hidden fallback list).

## D18 — One AI request per page; overload retry; status from the latest real call
After the model fix, live logs showed Google 429 "free_tier_requests, limit: 5, model:
gemini-3.8-flash" (5 requests per minute) and 503 "high demand". Page summaries now use one model
call per page (all sections; shorter points) instead of parallel chunks; the adapter retries once
after 1.2 s on 500/503 when time allows; 429 and 503 are explained in plain words (wait time,
billing option). The footer AI badge reports the workspace's latest real AI call (no request
spent); a live test request is sent only when the user clicks "Check again". Summary cards offer
"Try AI again". Netlify `AI_TIMEOUT_MS` default is 9000.

## D19 — Overload retries and an owner-chosen backup model
`gemini-3.8-flash` answered 503 "high demand" repeatedly for this key (Netlify and local). The
adapter now retries 500/503 up to three times (1.5 s, 3 s, 6 s) while the request deadline allows,
and, if `AI_FALLBACK_MODEL` is set, tries that model once when the first is busy, over quota or
unavailable. The backup is explicit owner configuration (D11 still holds: no built-in list);
`npm run ai:models` lists the models the key can use so names are not guessed. The answering
model is reported with each result.

## D20 — Draft AI edits use an explicit field schema
Live use showed the AI replying "I have updated the intro" while nothing changed: the structured
output schema declared `changes` as an object with no properties, so the model returned `{}`. The
request now lists every editable text field per channel (email subject/headline/intro/bullets/…,
SMS text, push title/body/buttons), the prompt maps everyday words ("body", "header", "list") to
those fields, flat answers for a single chosen channel are accepted, and a reply with no actual
edit says so instead of implying a change. Line breaks in email text render as `<br>`.

## D21 — NVIDIA API catalog as a backup or main AI provider
At the owner's request, an OpenAI-compatible adapter (`OpenAiCompatibleProvider`, base URL
`NVIDIA_BASE_URL`, default `https://integrate.api.nvidia.com/v1`) can be the main provider
(`AI_PROVIDER=nvidia`) or — when `AI_PROVIDER=gemini` and `NVIDIA_API_KEY`/`NVIDIA_MODEL` are set —
the backup used only when Gemini is busy, over quota, unavailable or too slow, within the same time
budget. JSON mode is requested and dropped if the model refuses it; the schema is always in the
system message and the answer passes the same evidence/field validation as Gemini output. The
endpoint and JSON-mode support are not verified from this environment (network policy) and must be
confirmed on the owner's machine; `npm run ai:nvidia` lists the models the key can use.

## D22 — Ask AI analyses the whole dashboard, live
Ask AI defaults to the whole dashboard: the Summary's snapshot for the selected period, with the
page facts (KPIs, improved/declined, campaigns, revenue/channels, programs, subject lines,
creative, launch days, offers, limits) plus one fact per campaign. The AI cites fact ids and may
only use their numbers (same validation as before); without AI, answers pick the facts the
question is about. "One campaign" keeps the campaign report. The conversation is keyed by scope,
not snapshot: a new import or period switches to the new snapshot with a visible notice. Every AI
box on Summary, Analyze, Compare and Simulator has "Ask AI", which opens Ask AI with that question
already sent.
- **D23** — With a backup model and an AI time limit of 20 s or more, the main Gemini model gets 60% of the limit; if it does not answer, the backup gets the rest. Draft edits cap output at 4096 tokens. Local default AI_TIMEOUT_MS is 90000. `npm run ai:test` times one real request per model.
- **D24** — Simulator review fixes (2026-10-22). Campaign `launchCount` / `firstLaunchDate` / `lastLaunchDate` now describe the selected period; whole-file history is in `datasetLaunchCount` / `datasetFirstLaunchDate` / `datasetLastLaunchDate` (report format `report-format-2026-10-22.1`). Connect diagnostics take `toExclusive` (the report's `endDateExclusive`) and compare run days in the account timezone; `to` stays inclusive. The simulator's default audience is messages sent minus unsubscribes and complaints of the chosen baseline (checkbox, on by default); bounces are not subtracted because the delivery rate already contains them; counts are labelled as messages, not people. The strategy "AI pick" is the model's choice from `STRATEGY_OPTIONS`, requested in the same call as the AI Strategy Brief and accepted only with known fact ids, numbers from the facts and no causal words; otherwise the ranking is labelled "Top match (rules)". "Create campaign" opens the builder on the template picked in the simulator and stores the plan (strategy, audience, program, assumptions) on the draft as a record; no audience or program is created. Ask AI receives the scenario on screen for the same report as `scenario` facts, worded as assumptions and estimates. Strategy and template choices do not change projections; outcomes are for one send, not a period forecast — both stated on screen.
