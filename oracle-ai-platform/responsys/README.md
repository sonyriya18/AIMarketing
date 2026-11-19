# Responsys Campaign Intelligence

> **Windows / Visual Studio Code:** follow [START-HERE-WINDOWS.md](START-HERE-WINDOWS.md) — install, `npm run setup:local`, `npm run dev`, open http://localhost:3000. Sample data: `samples/sample-campaigns.csv`. Add a Gemini key with `npm run ai:key`.

Analyze Oracle Responsys campaign performance from **your real data** — uploaded CSV exports or a
verified Responsys connection. Every number on screen comes from a deterministic, versioned
report snapshot; missing data is shown as unavailable, never invented.

## What you can do

- **Data** — upload a CSV, confirm its mapping (timezone, currency, coverage), activate it. Connect Responsys.
- **Summary** — account KPIs for any period vs. a comparison period, with "Inspect" on every number.
- **Analyze Campaign / Compare Campaigns** — one campaign vs. a benchmark, or two side by side.
- **Scenario Planner** — projections from *your stated assumptions* (clearly labeled, not measured).
- **Ask AI** — questions answered only from the report's evidence (rule-based when AI is off).
- **Drafts** — build email/SMS/push content, save versions, request approval. Nothing is sent.
- **Save Report** — CSV, JSON, Markdown or PDF of exactly what is on screen.

## Run locally (step by step)

Prerequisites: Node.js 22.12+, PostgreSQL 16.

```bash
# 1. Start PostgreSQL (Linux example; on macOS: brew services start postgresql@16)
sudo service postgresql start

# 2. Install dependencies
npm ci

# 3. Create database roles, dev + test databases, run migrations, write .env.local
#    (uses PG_ADMIN_URL, default postgres://postgres:postgres@localhost:5432/postgres)
npm run setup:local

# 4. Start the app (API + frontend + in-process worker)
npm run dev
```

Open <http://localhost:3000>, sign in with any email (local dev sign-in), create a workspace and
an account, then upload `tests/fixtures/golden-campaigns.csv` on the **Data** tab to try it.

## Business-aware recommendations

Sign in with email first (or organizational SSO). After authentication, choose an account from the separate account-selection page; private workspace account names are never listed before authentication. Configured businesses include **Amil** and **Endeavour Group - DM** (`https://www.danmurphys.com.au/dm/home`). Selecting an existing account reuses its saved data. A workspace owner can continue with a new configured business to create its own empty account; Endeavour defaults to Australia/Sydney and AUD. “Other account” allows custom setup. Website changes remain available in this entry flow.

Account selection and website controls stay in the entry flow instead of appearing on report pages. The chosen account is remembered across reloads for the current browser tab and workspace; a fresh sign-in always asks for an account. Switching cancels pending queries, removes transient cached report data, resets report filters and mounts a fresh account screen. Uploads, datasets, drafts and scenarios remain stored under their original account, so returning to Amil restores its uploaded files while a new Endeavour account has none. Its logo appears at the far right of the application header; click the logo to return to account selection. Amil uses the official Amil Dental logo downloaded from `https://www.amildental.com.br/file/general/Amil_dental_Positiva_Colorida_RGB-01.png`, bundled locally in the application. Other accounts use their official website icon with a name fallback if the icon cannot be loaded.

AI summaries read the public HTTPS homepage and up to two same-origin business/product pages. Website excerpts are untrusted context, separate from measured campaign facts. Business-specific recommendations and simulator strategies must cite both website and report evidence. Tailored strategy cards include a business rationale, proposed tests, and inspectable evidence. Unsupported strategy categories are omitted when tailored options are available. Existing scenario calculations remain projections from report data and explicit assumptions.

Amil and Amil Dental use the configured public website `https://www.amildental.com.br/` when no account website has been saved. An explicitly saved URL takes precedence; unknown businesses still need a supplied website. No report data is shared between accounts. Verified dental website content also enables rule-written dental playbooks when AI omits its strategy list, fails, is disabled or is over budget. These cards are labeled “Website + report · Rules” and cite both source types. The sector is detected from retrieved website text, never from the account name alone. Generic card names returned by AI are rejected. A simulator response with no validated business strategies is not cached as a successful business-strategy result.

An AI provider and the `ai.use` permission are required for tailored strategies. Without AI, readable website content, or validated model output, the app explicitly shows general, rule-based options. Sites that block automated requests, require JavaScript to expose their content, or redirect to another origin may be unavailable; use the final official HTTPS URL. The app does not guess a website from an account name or claim to have researched an inaccessible site.

Website retrieval uses public IPv4 addresses pinned per connection, official-origin redirects (including apex/www canonicalization), a 20-second reading budget and page size limits. Oracle Commerce storefronts such as Amil Dental publish visible content through a public same-origin page endpoint; the reader extracts that content without executing website JavaScript. Successful context is reused for 15 minutes, failures for one minute. Summary caches include a website-content fingerprint. The URL is stored in the existing account brand settings.

## Launch-time simulation

The simulator uses different program structures for each strategy, including nested decisions. Discovery sends alternative content to non-clickers; onboarding sends a scheduled sequence before evaluating engagement; retention checks support requests before any email; hygiene gates on eligibility and confirmed preference updates; re-engagement sends the next-step guide to responders and pauses non-responders; acquisition rechecks completion after its guide; completion help waits and checks incomplete status before outreach; win-back verifies return eligibility first.

The Recommended Campaigns & Templates section is projected directly from the displayed program graph. Entry/filter conditions, wait, decision criteria and branches, exits and campaign choices appear only for objects present in that flow. Exclusion criteria appear only when an explicit exclusion-filter object is present; unused exclusion rules are also omitted from newly saved draft metadata. Selecting a campaign reveals only its own email layouts and a rendered preview; changing strategy clears the old selection. Saved draft source records include the actual program objects and connections. Custom status fields, support requests, preference events and completion signals remain proposed mappings, never claims about available recipient data. Historical campaign baselines remain available separately in the simulation section.

Standard field names and values follow [Oracle's profile-list field reference](https://docs.oracle.com/en/cloud/saas/marketing/responsys-user/List_SystemFields.htm). `CONTACTS_LIST` is a placeholder list name; suggested PET names and business fields are explicitly labeled as proposed mappings. Aggregate campaign reports do not verify recipient schemas, eligibility or matching recipient counts. No program, filter, list or send is created in Responsys.

Amil accounts automatically receive an Amil Dental business content pack with campaign-specific initial/follow-up copy and customer-inspired brand-story/checklist layouts. These drafts omit borrowed prices, clinical benefit claims, statistics and assumed template lift. Existing explicitly selected customer example packs remain available in the builder. The selected campaign, template and complete proposed entry/filter/exclusion criteria are retained with newly created drafts as reviewable source metadata.

Welcome and re-engagement campaigns can optionally include published website offers from readable HTML promotion sections or Oracle Commerce benefit-card configuration. Copy retains its published wording and language, source, retrieval date and audience restrictions. Offers require an explicit terms/eligibility confirmation, are scoped to the selected campaign, and research older than 24 hours is not selectable. Member-only benefits are unavailable to the inactive-prospect re-engagement audience. The selected offer appears in both email layouts and persists as draft content and source metadata. Map the `WEBSITE_OFFER` link-table entry to the displayed official offer URL in Responsys. Missing, unreadable or unsuitable offers leave the business guidance intact; offer selection does not imply performance lift or create a live send.

The simulator asks for target audience, launch weekday and launch time instead of open/click multipliers, order value or an uncertainty slider. Optional **Launch Time** (`HH:mm` or `HH:mm:ss`, in the confirmed dataset timezone) is supported by campaign imports and downloadable templates. Apply migration `004_launch_time.sql` before running the updated server; older rows keep a null time and remain valid.

Estimates use same-channel launch weekday/hour cohorts with at least three launches and 100 delivered. Historical open/click rates are blended with the selected baseline using weight `delivered / (delivered + 500)`. The best observed eligible hour is ranked by open rate, with click rate as tie-breaker. When the selected hour has insufficient history, the estimator uses the matching launch weekday or the baseline. It never assumes uplift for an unobserved hour or invents send times from a summary file. This method has not been calibrated as a predictive model and does not establish a causal send-time effect.

Conversion and recorded order value remain at baseline; changing launch time does not scale revenue. Engagement estimates remain available when revenue inputs are missing. Saved revenue scenarios retain launch settings and engagement estimates; Ask AI and draft plan notes include the selected schedule. Nothing is actually scheduled or sent.

## Checks

| Command | What it proves |
|---|---|
| `npm run typecheck` | Strict TypeScript for browser and server |
| `npm test` | Unit, integration (real PostgreSQL), contract and security tests |
| `npm run test:e2e` | Browser journey upload → summary → campaign → compare → scenario → ask → draft |
| `npm run build` | Production frontend + server bundles |
| `npm run verify:no-demo` | Production bundles contain no fixtures, mock analytics or dev middleware |

## Production

```bash
npm run build
npm run db:migrate:prod      # uses DATABASE_MIGRATION_URL
npm run start:api            # API + static frontend
npm run start:worker         # background jobs and scheduled sync
```

Production requires `AUTH_MODE=oidc`, HTTPS `APP_BASE_URL`, and secrets from a secret manager.
See `.env.example` for every setting.

## Deploy on Netlify

See `docs/DEPLOY_NETLIFY.md` (Google sign-in setup, environment variables, limits).

## Documentation

- `docs/IMPLEMENTATION_STATUS.md` — what works and how it was verified
- `docs/DATA_DICTIONARY.md` — metric definitions and CSV formats
- `docs/RESPONSYS_SETUP.md` — connecting Responsys safely
- `docs/DECISIONS.md`, `docs/IMPLEMENTATION_PLAN.md`, `docs/VERIFICATION.md`
