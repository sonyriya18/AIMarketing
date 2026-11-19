# Responsys v17 inside the platform (single sign-on)

Responsys is the 4th tool in the platform. It is your **unchanged v17 application**, opened from a company's home page. The platform does the sign-in, so:

- only companies whose subscription includes **Oracle Responsys** can open it;
- the person arrives in v17 already signed in, with their platform email.

No v17 code is changed. Only v17's local settings file (`.env.local`) is switched from its own email sign-in to "sign in with the platform". A backup is kept.

> **Current release (Windows package).** The `responsys/` folder is now the TL's Windows release (`AIMarketing-Claude-Upload.zip` with `AIMarketing-Dependencies-Part01`–`Part07`), byte-for-byte unchanged (`node preservation/verify-responsys.mjs` checks 186 files). It brings its own Node.js 24 (`responsys\runtime\node`) and PostgreSQL 16 (`responsys\runtime\pgsql`). `1-SETUP.cmd` runs its own `Setup.ps1` once to create its private database in `responsys\.local`. When the platform starts, it starts that database and runs Responsys the same way its `Start.ps1` does (`server/index.ts` with the prebuilt screens), with the platform's sign-in and ChatGPT settings passed in as environment variables. Nothing needs to be installed on the PC. See `START-HERE-WINDOWS.md`.

## Easiest: one port (3006), one login
Set `RESPONSYS_DIR=<your v17 folder>` in the platform's `.env`, then run `npm run dev`. The platform:
- starts v17 itself;
- serves it at http://responsys.localhost:3006;
- passes v17 its sign-in settings as environment variables (generated secret, platform issuer).

Nothing in v17's folder is changed, and v17 keeps its own database and AI settings from its `.env.local`. The `responsys:link` command below is only needed when v17 runs separately (for example on another server).

## How it works

1. A user clicks **Oracle Responsys** on their company's home page.
2. v17 opens in a new tab and asks the platform to sign the user in.
3. The platform checks all of these before answering:
   - the user is signed in to the platform;
   - their current company is active;
   - Responsys is in that company's subscription, inside its start and end dates;
   - the user has been given Responsys access;
   - v17's address is the one registered for that company.
4. If every check passes, v17 receives a one-time code (valid 60 seconds) and signs the user in. If not, the user sees "Responsys is not part of your subscription" and v17 is never reached.

**Technical details.** The platform is a minimal OpenID Connect provider at `<platform address>/sso`:

- Authorization code flow with PKCE (S256), state and nonce.
- RS256-signed ID tokens. The signing key is created on first use and stored encrypted in the platform database.
- One registered client, `responsys-v17`, with a shared secret.
- The subscription is checked again when the token is issued.

## Set it up on your PC (one time)

Before you start:

- v17 already works on its own (you ran `npm ci` and `npm run setup:local` in its folder);
- the platform runs from the `oracle-ai-platform` folder.

1. Open a terminal in the `oracle-ai-platform` folder and run (use your own v17 folder path):
   ```
   npm run responsys:link -- "C:\Users\Sony\path\to\AIMarketing"
   ```
   This does four things:
   - backs up v17's `.env.local` to `.env.local.before-sso`;
   - sets v17 to sign in through the platform (`AUTH_MODE=oidc`, `OIDC_ISSUER_URL=<platform>/sso`, `OIDC_CLIENT_ID=responsys-v17`, `OIDC_CLIENT_SECRET=…`);
   - writes `RESPONSYS_URL` (v17's address) and the same secret (`RESPONSYS_SSO_SECRET`) into the platform's `.env`;
   - never prints the secret.
2. Restart both apps: press **Ctrl+C** in each terminal, then run `npm run dev` in each folder.
3. In the platform, open **Provider console** and make sure the company has **Oracle Responsys** ticked. Optionally set a company-specific Responsys address there. Use **Check Responsys v17** to confirm it is running with single sign-on.
4. Go to that company's home page and click **Oracle Responsys**.

The first time, v17 shows its own "Create your workspace" screen. That is v17's normal first run: its campaign data lives in v17's own workspace.

**To undo**, run the same command with `--undo` at the end. It restores v17's previous settings and turns platform single sign-on off.

**If you change the platform port.** The platform's address is read from `APP_ORIGIN` in its `.env`. If you change the platform's port later (for example to 3005), run the link command again.

## Several companies

- **One v17 for everyone (simplest):** set `RESPONSYS_URL` once. Each company works in its own v17 workspace.
- **One v17 per company:** in the Provider console, set each company's own Responsys address. The platform refuses to sign a user in to any other company's v17.

## Production notes

- Use HTTPS addresses for both apps. Production refuses `http://` Responsys addresses.
- Platform users must sign in through your organization's identity provider (OIDC with a verified email). Only then does the platform vouch for the email to v17.
- Store `RESPONSYS_SSO_SECRET` and v17's `OIDC_CLIENT_SECRET` in your secret manager, never in files you share.
- v17 sessions last as long as v17's `SESSION_TTL_HOURS` (default 12 hours). Removing Responsys from a subscription blocks new sign-ins immediately. It does not end a v17 session that is already open.

## Verification done

| Check | Result |
|---|---|
| Contract test (`tests/sso.test.ts`) | Passes. Uses `openid-client` 6.8.8, the same library and version as v17, exactly as v17 calls it. Covers discovery, sign-in, one-time code, wrong secret, wrong PKCE verifier, unsubscribed company, unregistered address, signed-out user, and a subscription removed mid-sign-in. |
| Live local test with the real, unmodified v17 | Passes (v17 on PostgreSQL 16, platform on embedded PostgreSQL). A company with Responsys opened v17 signed in as the platform user; a company without it was refused. |
| Live local test with the TL's Windows release (unchanged) | Passes on Linux with the same code: the platform started it, signed in through `/sso`, and it showed its own first-run "Create your workspace" screen inside the platform. The Windows `.exe` runtime itself was not run here (no Windows machine in the test environment). |
| Deployed or production test | Not done. |
