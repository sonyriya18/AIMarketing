# Deploy on Netlify

Site: **responsys-campaign-intelligence** → https://responsys-campaign-intelligence.netlify.app
(team "sonymadhus42", free plan). Design: `docs/DECISIONS.md` D12.

## What runs where

| Part | Netlify feature |
|---|---|
| Screens (React) | Static files from `dist/` (`npm run build:web`) |
| API (`/api/*`) | Function `netlify/functions/api.mts` |
| Background jobs + scheduled Responsys sync | After each change, plus function `jobs-cron` every 5 minutes |
| Database | Netlify Database (Postgres), prepared automatically on first request |
| Uploaded files | Netlify Blobs (private) |

## One-time setup: Google sign-in (about 10 minutes)

The app refuses to accept sign-ins until these steps are done.

1. Open https://console.cloud.google.com/ and create a project (any name).
2. Go to **Google Auth Platform → Branding**, click **Get started**, enter an app name and your
   support email, choose audience **External**, and finish.
3. Go to **Audience → Test users** and add every Google account that should be able to sign in.
4. Go to **Clients → Create client**:
   - Application type: **Web application**
   - Authorized redirect URI:
     `https://responsys-campaign-intelligence.netlify.app/api/v1/auth/oidc/callback`
   - Click **Create** and keep the **Client ID** and **Client secret** window open.
5. In Netlify: **Project configuration → Environment variables → Add a variable**, and add:

   | Key | Value | Secret? |
   |---|---|---|
   | `OIDC_CLIENT_ID` | the Client ID | no |
   | `OIDC_CLIENT_SECRET` | the Client secret | **yes** (tick "Contains secret values") |
   | `ALLOWED_SIGNIN_EMAILS` | your email, comma-separated emails, or `@yourcompany.com` | no |

6. **Deploys → Trigger deploy → Deploy project** (environment changes apply on the next deploy).

Already set by setup: `APP_BASE_URL`, `OIDC_ISSUER_URL=https://accounts.google.com`,
`ALLOW_WORKSPACE_CREATION=true`.

## Optional: AI answers (Gemini)

Add `AI_PROVIDER=gemini`, `AI_MODEL=<model name>` (a model your key can use today — Google retires
older models; on 2026-10-16 Google answered `gemini-2.5-flash` with "no longer available to new users"
and named `gemini-3.8-flash`) and `GEMINI_API_KEY` (mark as secret), then
redeploy. Without them, "Ask AI" gives clearly labeled rule-based answers.

## Check it works

- The site address shows the sign-in page right after deploying.
- Until step 5 is done, sign-in shows "Sign-in is not available yet" (API answers
  `503 not_configured`). That is expected.
- After step 5: https://responsys-campaign-intelligence.netlify.app/api/health/ready shows
  `"database": true, "objectStorage": true`, and **Sign in with Google** works.

## Limits on Netlify

- Uploads up to 4 MB per file.
- Screens refresh about every 5 seconds instead of a live stream.
- Jobs normally finish right after the action; anything left runs within 5 minutes.
- Netlify Database uses plan credits; check usage under **Team → Billing**.

## Redeploying from this repository

`netlify.toml` holds the build settings. Never put secrets in it — use environment variables.
