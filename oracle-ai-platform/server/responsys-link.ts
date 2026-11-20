// Opens Responsys like the other three applications: no separate sign-in and no first-run setup
// screens. When a person signs in to Responsys through the platform (single sign-on), the platform
// prepares their Responsys session through Responsys's own public API, acting as that person
// (their session cookie and CSRF token), exactly as if they had clicked the same buttons:
//   1. the company's Responsys workspace (created once, named after the company, then reused);
//   2. the company's members with Responsys access, added to that workspace with matching roles;
//   3. the company's business account in Responsys (created once from the company's branding);
//   4. the browser lands straight on that account's Summary.
// No Responsys code or data is changed outside its API. Every step is best-effort: if one fails,
// Responsys simply shows its own screen for that step.
import http from "node:http";
import type { Database } from "./db";
import type { Config } from "./config";
import { hash } from "./security";
import type { Brand } from "../shared/clients";

type Call = (
  method: string,
  path: string,
  body?: unknown,
) => Promise<{ status: number; data: any }>;

/** Responsys roles for platform roles (platform administrator = Responsys owner). */
export const RESPONSYS_ROLE: Record<string, string> = {
  owner: "owner",
  analyst: "analyst",
  viewer: "viewer",
};

/** Who and which company a single sign-on code was issued for (read before Responsys redeems it). */
export async function peekSsoCode(db: Database, code: string) {
  const { rows } = await db.query(
    "SELECT value FROM sso_codes WHERE code_hash=$1 AND expires_at>now()",
    [hash(code)],
  );
  const v = rows[0]?.value;
  return v && typeof v === "object"
    ? {
        userId: String(v.userId),
        email: String(v.email),
        workspaceId: String(v.workspaceId),
      }
    : null;
}

/** "name=value; name2=value2" from a response's Set-Cookie headers. */
export function cookieHeader(setCookie: string[] | undefined) {
  return (setCookie || [])
    .map((c) => c.split(";")[0].trim())
    .filter((c) => /^[^=\s]+=/.test(c))
    .join("; ");
}

function caller(cfg: Config, cookie: string): Call {
  let csrf = "";
  return (method, path, body) =>
    new Promise((resolve, reject) => {
      const payload =
        body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = http.request(
        {
          host: "127.0.0.1",
          port: cfg.responsysInternalPort,
          method,
          path: "/api/v1" + path,
          headers: {
            host: cfg.responsysHost,
            cookie,
            accept: "application/json",
            ...(payload
              ? {
                  "content-type": "application/json",
                  "content-length": payload.length,
                }
              : {}),
            ...(csrf ? { "x-csrf-token": csrf } : {}),
          },
          timeout: 8000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            let data: any = null;
            try {
              data =
                JSON.parse(Buffer.concat(chunks).toString("utf8"))?.data ??
                null;
            } catch {
              data = null;
            }
            if (path === "/session" && data?.csrfToken) csrf = data.csrfToken;
            resolve({ status: res.statusCode || 0, data });
          });
        },
      );
      req.on("timeout", () =>
        req.destroy(new Error("Responsys did not answer in time")),
      );
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
}

export interface LinkResult {
  workspace?: string;
  account?: string;
  added: string[];
  note?: string;
}

/** Prepares the signed-in person's Responsys session for their platform company. */
export async function prepareResponsys(
  db: Database,
  cfg: Config,
  who: { userId: string; email: string; workspaceId: string },
  cookie: string,
  call: Call = caller(cfg, cookie),
): Promise<LinkResult> {
  const result: LinkResult = { added: [] };
  const { rows } = await db.query(
    `SELECT name,brand,responsys_workspace_id AS "rsWorkspace",responsys_account_id AS "rsAccount" FROM workspaces WHERE id=$1`,
    [who.workspaceId],
  );
  const company = rows[0];
  if (!company) return result;
  const brand: Brand = company.brand || {};
  let s = (await call("GET", "/session")).data;
  if (!s?.user) return { ...result, note: "Responsys session not found" };
  const memberships: { workspaceId: string; name: string; role: string }[] =
    s.memberships || [];

  // 1. The company's Responsys workspace: the linked one, else one of the person's own that has
  //    the company's name (set up by hand earlier), else a new one.
  let wsId: string | undefined =
    memberships.find((m) => m.workspaceId === company.rsWorkspace)
      ?.workspaceId ||
    (!company.rsWorkspace
      ? memberships.find((m) => m.name === company.name && m.role === "owner")
          ?.workspaceId
      : undefined);
  if (!wsId && company.rsWorkspace)
    return {
      ...result,
      note: "Not yet a member of the company's Responsys workspace; a company administrator adds members by opening Responsys once.",
    };
  if (!wsId) {
    const created = await call("POST", "/workspaces", {
      name: company.name.slice(0, 120),
    });
    if (created.status !== 201 || !created.data?.id)
      return { ...result, note: "Responsys did not create the workspace" };
    wsId = created.data.id as string;
  }
  if (company.rsWorkspace !== wsId)
    await db.query(
      "UPDATE workspaces SET responsys_workspace_id=$2 WHERE id=$1",
      [who.workspaceId, wsId],
    );
  if (s.workspace?.id !== wsId) {
    await call("POST", "/session/workspace", { workspaceId: wsId });
    s = (await call("GET", "/session")).data;
  }
  result.workspace = wsId;
  const owner = s?.workspace?.role === "owner";

  // 2. Members: everyone in the company whose access includes Responsys (owners only can add).
  if (owner) {
    const members = await db.query(
      `SELECT u.email,m.role FROM memberships m JOIN users u ON u.id=m.user_id
        WHERE m.workspace_id=$1 AND m.apps ? 'responsys' AND u.email<>$2`,
      [who.workspaceId, who.email],
    );
    const current = await call("GET", "/workspace/members");
    const have = new Map<string, string>(
      (Array.isArray(current.data) ? current.data : []).map((x: any) => [
        String(x.email).toLowerCase(),
        String(x.role),
      ]),
    );
    for (const m of members.rows) {
      const role = RESPONSYS_ROLE[m.role] || "viewer";
      if (have.get(m.email) === role || have.get(m.email) === "owner") continue;
      const r = await call("POST", "/workspace/members", {
        email: m.email,
        role,
        grants: [],
      });
      if (r.status < 300) result.added.push(m.email);
    }
  }

  // 3. The company's business account (Responsys's own account list, reused when it exists).
  const accounts = await call("GET", "/accounts");
  const list: { id: string; name: string }[] = Array.isArray(accounts.data)
    ? accounts.data
    : [];
  const wanted = (
    brand.responsysAccount ||
    brand.displayName ||
    company.name
  ).trim();
  let account =
    list.find((a) => a.id === company.rsAccount) ||
    list.find((a) => a.name.toLowerCase() === wanted.toLowerCase());
  if (!account && owner) {
    const created = await call("POST", "/accounts", {
      name: wanted.slice(0, 120),
      timezone: brand.timezone || "UTC",
      currency: brand.currency || "USD",
      ...(brand.responsysWebsite || brand.website
        ? {
            brand: { officialWebsite: brand.responsysWebsite || brand.website },
          }
        : {}),
    });
    if (created.status < 300 && created.data?.id) account = created.data;
  }
  if (!account && list.length === 1) account = list[0];
  if (account) {
    result.account = account.id;
    if (company.rsAccount !== account.id)
      await db.query(
        "UPDATE workspaces SET responsys_account_id=$2 WHERE id=$1",
        [who.workspaceId, account.id],
      );
  }
  return result;
}

/** Where to send the browser after sign-in: straight to the account's Summary when known. */
export function landingFor(location: string | undefined, link: LinkResult) {
  if (
    !link.account ||
    !location ||
    !location.startsWith("/") ||
    location.startsWith("//")
  )
    return location;
  const u = new URL(location, "http://x");
  if (u.pathname !== "/" || u.searchParams.has("signinError")) return location;
  u.searchParams.set("account", link.account);
  if (!u.searchParams.has("tab")) u.searchParams.set("tab", "briefing");
  return u.pathname + u.search;
}
