# Oracle AI Platform: start here (Windows)

One platform, four applications, one sign-in:

| Application | What it is for |
|---|---|
| **Oracle Responsys** | Responsys Campaign Intelligence, unchanged (its own screens, calculations and AI). Opens inside the platform with the same sign-in, straight into the company's account. |
| **Oracle Eloqua** | Campaigns, emails, nurture programs, forms, engagement, plus campaign and content recommendations. Email Builder with **Refine with AI**: ask for changes in your own words, review the proposal, then apply it. |
| **Oracle Unity** | Customer profiles, data quality, audiences, identity links, consent, plus fix-it recommendations. |
| **Oracle Infinity** | Website and app behaviour, journeys, conversions, drop-off, tracking quality, plus improvement recommendations. |

Client included as a template: **Endeavour Group** (logo in the header, official website, facts with sources, alcohol-marketing rules the AI follows).

---

## 1. Extract (once)

1. Make a folder, for example `C:\Apps`.
2. Right-click `Oracle-AI-Platform-Final.zip` → **Extract All** → choose `C:\Apps`.
3. You now have `C:\Apps\Oracle-AI-Platform-Final\oracle-ai-platform\` with `1-SETUP.cmd`, `2-START.cmd` and `3-CHECK-AI.cmd` inside. Open **that** `oracle-ai-platform` folder in VS Code.
4. `2-START.cmd` prints the release on its first line (see `VERSION.txt`), so you can check you are running this version.

Nothing else needs to be installed. Node.js 24 and PostgreSQL 16 are included in `responsys\runtime`.

> **Updating from v7?** Copy two things from your old v7 `oracle-ai-platform` folder into the new one: the `.data` folder (your companies, users and uploads) and the `.env` file (your settings and AI key). The new version upgrades the data automatically and only adds the new branding column. Nothing is deleted. Keep the old folder as a backup until you have checked everything.

## 2. Set up (once): double-click `1-SETUP.cmd`

It:
1. checks that every part was extracted;
2. creates the private Responsys database (inside `responsys\.local`) with Responsys's own `Setup.ps1`;
3. creates the platform settings file `.env` (or keeps yours);
4. asks for your **OpenAI key**: paste with **right-click**, then press Enter. Then type the **model ID**. Press Enter alone to keep what is already set.

The key is saved only in the platform `.env`. Responsys receives the same key when the platform starts it.

## 3. Start: double-click `2-START.cmd`

- Keep the window open. Closing it stops the apps.
- The browser opens **http://localhost:3006** when it is ready.
- Responsys opens inside the platform at http://responsys.localhost:3006 with the same sign-in.
- Optional: to stop the Responsys database too, run `responsys\Stop-Database.cmd`.

## 4. First use

1. Sign in with your work email. Locally the first person to sign in becomes the **platform administrator**.
2. Open **Provider console**, then **Add a client company**:
   - **Client template:** choose *Endeavour Group*. This fills in the name, logo, website, facts and rules.
   - Tick the applications this client subscribes to, then click **Create company**.
3. Use **Branding & links** on the company to change logos, colours, websites or rules, or to add the client's own Oracle login addresses.
4. Use **Workspace settings** to add members. For each person choose a role (viewer, analyst or administrator) and which applications they may open. People see only the applications that are both in the company's subscription and in their own list.
5. Open an application:
   - **Eloqua, Unity, Infinity:** go to **Data & connections**, add a source account, and upload exports (examples are in `examples\`). Then use Summary, Analyze, Compare, AI Simulator, Ask AI, the builders, drafts, reports and follow-up.
   - **Responsys:** opens like the others, with no separate login and no setup screens: the platform signs you in and prepares the company's Responsys workspace and business account (*Endeavour Group - DM*) automatically. Members with Responsys access are added when a company administrator opens Responsys (so an administrator opens it once after adding members). For live data use **Data & connections / Manage connection** with `responsys\config\responsys-credentials.json` (see `responsys\INSTALL-WINDOWS.txt`).

## 5. Check ChatGPT: double-click `3-CHECK-AI.cmd`

It shows whether the OpenAI key and model work from this PC, using the same proxy and certificate settings as `2-START.cmd`.

---

## Still needs your configuration

| Item | Where | Status |
|---|---|---|
| OpenAI key and model (with credit on the account) | `1-SETUP.cmd` | Without them, answers are rule-based and labelled as such. |
| The client's own Oracle login addresses (Responsys, Eloqua, Unity, Infinity) | Provider console → Branding & links | Not set: shown as "client login address not configured". We do not know Endeavour's tenant addresses. |
| Live Oracle connections (Eloqua, Unity, Infinity APIs) | Each app → Data & connections | **Not verified against a live Oracle tenant.** Uploads of exports work and are tested. Approved hosts go in `OUTBOUND_HOSTS` in `.env`. |
| Responsys API credentials | `responsys\config\responsys-credentials.json` | Blank in the package. Fill them in yourself and keep the file private. |
| Changes in Oracle systems | All apps | The platform only prepares drafts and actions. Nothing is published to Oracle without a person's approval. |
| Production sign-in (company single sign-on) and managed database | `docs/GO_LIVE_CHECKLIST.md` | Local email sign-in is for development only. |

## If something goes wrong

| Message | What to do |
|---|---|
| "These folders are missing" | Some parts were not extracted into the same folder. Extract them all again with **Yes to all**. |
| "Setup is not finished" | Double-click `1-SETUP.cmd`. |
| Responsys says the database is not running | Run `1-SETUP.cmd` again. Check `responsys\.local\postgres.log`. |
| Port 3006 in use | Close the other `2-START.cmd` window, or restart the PC. |
| ChatGPT not answering | Run `3-CHECK-AI.cmd`. On an office network, ask IT for the proxy and set `HTTPS_PROXY=` in `.env`. |

## Back up

Back up, while the apps are stopped: `.data`, `.env`, `responsys\.local`, `responsys\.env.local`, `responsys\config` and `responsys\var`. Never share `.env` or the credentials file. They contain secrets.
