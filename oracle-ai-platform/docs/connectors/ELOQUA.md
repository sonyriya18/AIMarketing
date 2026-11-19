# Oracle Eloqua connector setup

Status: **implemented and contract-tested with simulated responses. Not live verified.** No Eloqua tenant was available. The official documentation (references O1–O4, O13 in the build prompt) could not be fetched from the build environment, so re-check every item below against the current docs and the customer's release before connecting.

## What the adapter does (server/eloqua-connector.ts)

| Step | Method and path | Notes |
|---|---|---|
| Base URL discovery | `GET https://login.eloqua.com/id` | Never hardcodes a pod. The discovered host must be in `OUTBOUND_HOSTS`, otherwise the sync stops and names the host. |
| Campaign metadata | `GET {base}/api/REST/2.0/assets/campaigns?depth=minimal&count=1000&page=N` | Application API. Pages until `total` is reached; refuses after 200 pages. |
| Export definition | `POST {base}/api/bulk/2.0/activities/exports` | One definition per activity type (Bulk activity exports take one type each). Filter: type plus a `CreatedAt` window. |
| Sync | `POST {base}/api/bulk/2.0/syncs` with `{ "syncedInstanceUri": "/activities/exports/{id}" }` | The URI is saved to the job checkpoint **before** polling, so a crash never creates duplicate exports. |
| Poll | `GET {base}/api/bulk/2.0/syncs/{id}` | `pending`/`active` → keep polling within a 2-minute run budget, then hand back to the durable queue (re-queued after 15 s). `error` fails the job. `warning` marks the snapshot partial. |
| Retrieve | `GET {base}/api/bulk/2.0/syncs/{id}/data?offset=&limit=50000` | Complete only when `hasMore` is false. A missing `hasMore`, or an empty page while `hasMore` is true, fails the job. |
| Clean up | `DELETE {base}/api/bulk/2.0/activities/exports/{id}` | Only definitions this connector created. Anything not deleted is shown in Data & connections for administrator follow-up. |

These extraction POSTs create temporary export resources only. They never change campaigns, contacts or assets. There is no write adapter.

Default activity field maps follow the Bulk activity-field reference (`{{Activity.Id}}`, `{{Activity.CreatedAt}}`, `{{Activity.Contact.Id}}`, `{{Activity.Campaign.Id}}`, `{{Activity.Asset.Id}}`, `{{Activity.Field(EmailDeploymentId)}}`). Fields differ by activity type and release: confirm them, and override them with `activityFieldMaps` if the tenant differs.

**Delayed activity.** Each sync re-extracts the trailing `backfillDays` window (1–90). Rows are de-duplicated by activity type plus Activity ID, and each sync replaces the window snapshot. Eloqua returns timestamps without an offset, so you must enter the instance's `timestampOffset` (for example `-05:00`); without it the sync refuses rather than guessing.

## Authentication

- `eloqua-basic`: `Company\User:password` (Basic). Use only where the customer's policy permits it.
- `oauth`: authorization-code flow (`https://login.eloqua.com/auth/oauth2/authorize` and `/token`). Requires an App Cloud/app registration with a redirect URI of `APP_ORIGIN/api/connections/callback`. Refresh tokens are rotated and stored encrypted. Generic client-credentials or PKCE support is **not assumed**: confirm it for the tenant.
- Platform SSO (OIDC) is a different integration from the Eloqua connector.

## Setup steps

1. In `.env`, add `login.eloqua.com` and the tenant's pod host (for example `secure.p0X.eloqua.com`, as returned by `/id`) to `OUTBOUND_HOSTS`.
2. Create a dedicated, least-privilege Eloqua API user, with access to the campaigns and activities needed only.
3. In the platform, go to Eloqua → Data & connections → Add connection. Fill in the discovery URL, authentication, activity types, back-fill window and timestamp offset, then tick the contract confirmation.
4. Click **Test connection** (discovery plus a one-row campaign read), then **Sync now**.
5. Reconcile: compare sends, opens and clicks for one campaign and period with the native Eloqua report under the same filters. Record the evidence with **Record reconciliation evidence**. Differences must be investigated, not hidden.

## Not implemented / customer-dependent

Reporting API subject areas, contact field exports (use uploads), form/landing-page asset metadata via API, App Developer Framework callbacks (instant updates), and Eloqua write actions.

## Leads, sales, events and website visits (upload)

These are **uploads** (CSV or JSON). The connector does not sync them yet: no endpoints were verified for this build. Download each blank template in **Data & connections**. Every field is listed in `docs/DATA_DICTIONARY.md`.

| Upload type | Typical source | Unlocks |
|---|---|---|
| `lead` | Eloqua lead/contact export or CRM lead report with milestone dates | Lead funnel, MQLs waiting for sales, lead sources and ratings |
| `opportunity` | CRM opportunity report (`outcome` open/won/lost, amount, currency, leadId/contactId, campaignId) | Pipeline, won revenue, win rate, deal size, sales cycle, revenue by campaign |
| `marketing_event` + `event_registrant` | Eloqua event or webinar registrations, attendance from the webinar platform | Registrations, attendance, no-shows, attendee opportunities |
| `site_visit` | Eloqua website visit report (visitor/contact, first page, pages, duration) | Visits, known-visitor share, landing pages, visit-to-lead |

Policy settings (Data & connections → policy) and their defaults:

| Setting | Default |
|---|---|
| `leadMaturityDays` | 30 |
| `staleLeadDays` | 14 |
| `mqlAcceptanceThreshold` | 50% |
| `staleOpportunityDays` | 90 |
| `eventAttendanceThreshold` | 40% |
| `eventPipelineDays` | 90 |
| `knownVisitorThreshold` | 10% |
| `shortVisitSeconds` | 10 |
| `minCohort` | 30 |
