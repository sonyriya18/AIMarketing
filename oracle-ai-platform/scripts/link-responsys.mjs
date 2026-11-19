// Links your Responsys v17 app to this platform's sign-in (single sign-on). No v17 code is
// changed: only its local settings file (.env.local), after a backup. Secrets are generated here,
// written to the two local settings files and never printed.
//
//   npm run responsys:link -- "C:\path\to\AIMarketing"          link
//   npm run responsys:link -- "C:\path\to\AIMarketing" --undo   restore v17's previous sign-in
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const undo = args.includes("--undo");
const target = args.find((a) => !a.startsWith("--"));
const fail = (msg) => {
  console.error("\n" + msg + "\n");
  process.exit(1);
};
if (!target)
  fail(
    'Give the folder of your Responsys v17 app, for example:\n  npm run responsys:link -- "C:\\Users\\you\\rci\\AIMarketing"',
  );
const v17 = resolve(target);
const pkg = join(v17, "package.json");
if (
  !existsSync(pkg) ||
  JSON.parse(readFileSync(pkg, "utf8")).name !==
    "responsys-campaign-intelligence"
)
  fail(
    `${v17} is not the Responsys v17 app folder (no matching package.json).`,
  );
const v17Env = join(v17, ".env.local"),
  backup = join(v17, ".env.local.before-sso");
if (!existsSync(v17Env))
  fail(
    `${v17Env} does not exist. Set up v17 first (in that folder: npm ci, then npm run setup:local).`,
  );

const read = (f) => (existsSync(f) ? readFileSync(f, "utf8") : "");
const get = (text, key) =>
  (new RegExp(`^${key}=(.*)$`, "m").exec(text)?.[1] || "").trim();
const set = (text, key, value) => {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(text)) return text.replace(re, line);
  return (text && !text.endsWith(eol) ? text + eol : text) + line + eol;
};

const platformEnv = resolve(".env");
if (!existsSync(platformEnv)) {
  if (!existsSync(resolve(".env.example")))
    fail("Run this from the oracle-ai-platform folder.");
  copyFileSync(resolve(".env.example"), platformEnv);
}
let platform = read(platformEnv);

if (undo) {
  if (!existsSync(backup))
    fail(`No backup found (${backup}); nothing to restore.`);
  copyFileSync(backup, v17Env);
  writeFileSync(platformEnv, set(platform, "RESPONSYS_SSO_SECRET", ""));
  console.log(
    "\nRestored v17's previous sign-in settings and switched platform single sign-on off.\nRestart both apps (Ctrl+C, then npm run dev in each folder).\n",
  );
  process.exit(0);
}

const origin = get(platform, "APP_ORIGIN") || "http://localhost:3100";
const v17Text = read(v17Env);
let v17Url;
try {
  v17Url = new URL(get(v17Text, "APP_BASE_URL") || "http://localhost:3000")
    .origin;
} catch {
  fail("APP_BASE_URL in v17's .env.local is not a valid address.");
}
if (!existsSync(backup)) copyFileSync(v17Env, backup);
const secret = randomBytes(32).toString("base64url");
let next = v17Text;
for (const [k, v] of [
  ["AUTH_MODE", "oidc"],
  ["OIDC_ISSUER_URL", origin + "/sso"],
  ["OIDC_CLIENT_ID", "responsys-v17"],
  ["OIDC_CLIENT_SECRET", secret],
])
  next = set(next, k, v);
writeFileSync(v17Env, next);
platform = set(platform, "RESPONSYS_URL", v17Url);
platform = set(platform, "RESPONSYS_SSO_SECRET", secret);
writeFileSync(platformEnv, platform);
console.log(`
Linked. Responsys v17 (${v17Url}) now signs in through this platform (${origin}).
- v17 settings backup: ${backup}
- Secrets were written to both .env files and are not shown here.

Next:
  1. Restart this platform:  Ctrl+C, then npm run dev
  2. Restart Responsys v17:   in ${v17}: Ctrl+C, then npm run dev
  3. In the platform, give a company the Responsys tool (Provider console), then click
     "Oracle Responsys" on that company's home page.
To undo: npm run responsys:link -- "${target}" --undo
`);
