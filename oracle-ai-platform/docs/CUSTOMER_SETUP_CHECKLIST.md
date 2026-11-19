# Customer setup checklist (inputs needed for live use)

Provide values through a secret manager or a local `.env` on the server. Never put them in chat, email, tickets or committed files.

**Company and access**
- Company name and an HTTPS logo URL.
- Entitled applications (Responsys, Eloqua, Unity, Infinity) and contract dates.
- Members and roles.
- Who gets connector-administration and approval permissions.
- Source accounts per application, labeled production, test or sandbox, and which are restricted.

**Responsys v17 (single sign-on)**
- The HTTPS address of each company's v17 app (one shared `RESPONSYS_URL`, or one per company in the Provider console).
- A secret-manager entry shared by the platform (`RESPONSYS_SSO_SECRET`) and v17 (`OIDC_CLIENT_SECRET`). No v17 code changes; v17's settings use `AUTH_MODE=oidc`, `OIDC_ISSUER_URL=https://<platform>/sso` and `OIDC_CLIENT_ID=responsys-v17`.

**Subscriptions**
- For each client company: name, sign-in address, first administrator email, and the subscribed tools with start and end dates.
- The provider administrator emails (`PLATFORM_ADMIN_EMAILS`).

**Platform identity and hosting**
- OIDC issuer, client ID and secret, redirect URI `https://<host>/api/auth/callback`, and the bootstrap administrator email.
- Hosting and data region, managed PostgreSQL, backup/PITR policy, secret manager, TLS proxy.
- `APP_ORIGIN`, `SESSION_SECRET` (32+ characters) and `ENCRYPTION_KEY` (32 bytes, base64; back it up).

**Eloqua**
- The tenant (`login.eloqua.com/id` discovery) and pod host.
- Authentication method allowed by policy (OAuth app registration, or Basic) and a least-privilege API user.
- Activity types and back-fill window, and the instance timestamp offset.
- A representative native report for reconciliation.
- Lead stage milestone dates (MQL, sales accepted, SQL, opportunity, disqualified), opportunity exports with currency, event registrant exports and website visit exports, if those measures are wanted (otherwise they stay unavailable).

**Unity**
- Tenant and identity settings, and the approved grant and roles.
- Data model: objects, attributes and the master ID.
- Customer 360 rules/views.
- Permitted profile, segment and job sources, and the complete export method (including all output parts).
- Destination requirements: required fields and consent channel/purpose.
- Required fields per purpose.

**Infinity**
- Subscription, the authorized saved-report export URL and its report definition.
- Collection/event specification (tracking spec).
- Streams contract, if subscribed.
- Conversion event, journey steps and windows.

**AI**
- Provider and model (Gemini recommended for this build), API key, data-handling approval for aggregated evidence, daily request budget.
- Approved playbooks and brand guidance (text or Markdown).

**Business**
- Pilot objectives, metric definitions, rule thresholds (defaults are in `METRIC_DICTIONARY.md`), consent and suppression mappings, success criteria.
- The current manual time per review, if time saved should be reported (it needs a baseline).
