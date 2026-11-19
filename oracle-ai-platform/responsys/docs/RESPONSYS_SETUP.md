# Responsys setup

This app reads from Oracle Responsys. It never sends, publishes or deletes anything in Responsys
without explicit owner activation, and today all write actions are recorded as **blocked**.

## What you need from your Responsys admin

1. An API user (username + password) with permission to:
   - log in via the REST API, and
   - read performance reporting and Connect job runs for the account.
2. The login host for your pod, for example `https://login2.responsys.net`.
3. Confirmation that **Asynchronous Performance Reporting** is enabled for the account
   (it is a separately entitled feature).

## Step-by-step

1. **Store the credentials on the server, never in the browser.** Pick a short name, e.g. `MAIN`.
   - Option A — environment variables:
     ```
     RESPONSYS_MAIN_USERNAME=api_user
     RESPONSYS_MAIN_PASSWORD=********
     ```
     The connection's credential reference is then `env:MAIN`.
   - Option B — a JSON file outside the repo, pointed to by `RESPONSYS_CREDENTIALS_FILE`:
     ```json
     { "main": { "username": "api_user", "password": "********" } }
     ```
     The credential reference is then `file:main`.
2. **Restart** the API and worker so they read the new secrets.
3. In the app, open the **Data** tab (Responsys connection section), enter a display name, the login URL and the
   reference (`env:MAIN`). Raw passwords are refused.
4. Click **Test connection**. The worker logs in and records which capabilities actually work. The status
   badge only says "connected" after this check succeeds.
5. Click **Sync now** (or wait for the scheduler) to pull Connect job runs and reporting.

## Allowed hosts

Only hosts ending in `RESPONSYS_ALLOWED_HOST_SUFFIXES` (default
`.responsys.net,.responsys.ocs.oraclecloud.com`) over HTTPS are accepted, both for the login URL
and for the service endpoint returned by login. This prevents the server being pointed at
internal addresses.

## Documented API contracts used

| Purpose | Request |
|---|---|
| Login | `POST {login}/rest/api/v1.3/auth/token` form `user_name`, `password`, `auth_type=password` → `authToken`, `endPoint` (token ≈ 2 h) |
| Start report | `POST {endPoint}/rest/asyncApi/v1.3/performanceAnalytics/...` body `{sendFromDate, sendToDate}` (YYYY-MM-DD) → `requestId` |
| Poll report | `GET {endPoint}/rest/asyncApi/v1.3/performanceAnalytics/requests/{id}` (gzip when `Responsys-Content-Encoding: gzip`) |
| Connect runs | job runs with `sdate`/`edate` (MM-DD-YYYY); status `running/failed/succeeded/aborted` |

Requests are split into ≤ 30-day partitions and limited to 5 submissions per minute.

## Kill switches (all default `false`)

`ENABLE_PROVIDER_DRAFT_WRITES`, `ENABLE_PROOF_SENDS`, `ENABLE_LIVE_CAMPAIGN_SENDS`. Even when
enabled, an action also needs an approved draft version and a verified write capability.

## Current verification

Contract-tested with recorded fixtures only. **Live read verification is blocked** until an API
user, login host and reporting entitlement are available.
