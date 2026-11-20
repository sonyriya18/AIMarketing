// Responsys opens like the other applications: after single sign-on the platform prepares the
// person's Responsys session through Responsys's own API. A stand-in Responsys API records calls.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { config } from "../server/config";
import { Database } from "../server/db";
import {
  cookieHeader,
  landingFor,
  prepareResponsys,
} from "../server/responsys-link";
import { templateBrand } from "../server/brand";

const cfg = config({
  NODE_ENV: "test",
  DATA_DIR: ".data/tests-responsys-link",
  SESSION_SECRET: "test-session-secret-at-least-32-characters",
  ENCRYPTION_KEY: Buffer.alloc(32, 6).toString("base64"),
  RESPONSYS_DIR: "off",
});
const db = new Database(cfg, true);
const company = randomUUID();

/** Minimal Responsys: workspaces, memberships, accounts, per-user sessions. */
function fakeResponsys() {
  const state = {
    workspaces: [] as {
      id: string;
      name: string;
      members: Map<string, string>;
    }[],
    accounts: new Map<string, { id: string; name: string; body: any }[]>(),
    calls: [] as string[],
  };
  const as = (email: string) => {
    let current: string | null = null;
    return async (method: string, path: string, body?: any) => {
      state.calls.push(`${email} ${method} ${path}`);
      const mine = state.workspaces.filter((w) => w.members.has(email));
      const ws = state.workspaces.find((w) => w.id === current);
      if (path === "/session")
        return {
          status: 200,
          data: {
            user: { email },
            csrfToken: "t",
            workspace: ws ? { id: ws.id, role: ws.members.get(email) } : null,
            memberships: mine.map((w) => ({
              workspaceId: w.id,
              name: w.name,
              role: w.members.get(email),
            })),
          },
        };
      if (method === "POST" && path === "/workspaces") {
        const w = {
          id: randomUUID(),
          name: body.name,
          members: new Map([[email, "owner"]]),
        };
        state.workspaces.push(w);
        current = w.id;
        return { status: 201, data: { id: w.id, name: w.name } };
      }
      if (method === "POST" && path === "/session/workspace") {
        if (!mine.some((w) => w.id === body.workspaceId))
          return { status: 404, data: null };
        current = body.workspaceId;
        return { status: 200, data: { ok: true } };
      }
      if (!ws) return { status: 403, data: null };
      if (path === "/workspace/members" && method === "GET")
        return {
          status: 200,
          data: [...ws.members].map(([e, role]) => ({ email: e, role })),
        };
      if (path === "/workspace/members" && method === "POST") {
        if (ws.members.get(email) !== "owner")
          return { status: 403, data: null };
        ws.members.set(body.email, body.role);
        return { status: 201, data: {} };
      }
      const list = state.accounts.get(ws.id) || [];
      if (path === "/accounts" && method === "GET")
        return { status: 200, data: list };
      if (path === "/accounts" && method === "POST") {
        const a = { id: randomUUID(), name: body.name, body };
        state.accounts.set(ws.id, [...list, a]);
        return { status: 201, data: a };
      }
      return { status: 404, data: null };
    };
  };
  return { state, as };
}

beforeAll(async () => {
  await db.query("SELECT 1");
  const owner = randomUUID(),
    analyst = randomUUID(),
    noAccess = randomUUID();
  await db.query(
    "INSERT INTO workspaces(id,name,slug,brand) VALUES($1,'Endeavour Group',$2,$3)",
    [
      company,
      "edg-" + company.slice(0, 8),
      JSON.stringify(templateBrand("endeavour-group")),
    ],
  );
  for (const [id, email] of [
    [owner, "lead@example.test"],
    [analyst, "analyst@example.test"],
    [noAccess, "eloqua-only@example.test"],
  ])
    await db.query("INSERT INTO users(id,email) VALUES($1,$2)", [id, email]);
  await db.query(
    `INSERT INTO memberships(workspace_id,user_id,role,apps) VALUES
      ($1,$2,'owner','["responsys","eloqua"]'),($1,$3,'analyst','["responsys"]'),($1,$4,'viewer','["eloqua"]')`,
    [company, owner, analyst, noAccess],
  );
});
afterAll(() => db.close());

describe("Responsys opens without its own setup screens", () => {
  const rs = fakeResponsys();
  it("creates the company workspace and business account for the first administrator", async () => {
    const r = await prepareResponsys(
      db,
      cfg,
      { userId: "x", email: "lead@example.test", workspaceId: company },
      "rci_session=a",
      rs.as("lead@example.test"),
    );
    expect(rs.state.workspaces.map((w) => w.name)).toEqual(["Endeavour Group"]);
    // Members with Responsys access are added with matching roles; others are not.
    expect([...rs.state.workspaces[0].members]).toEqual([
      ["lead@example.test", "owner"],
      ["analyst@example.test", "analyst"],
    ]);
    const acct = rs.state.accounts.get(rs.state.workspaces[0].id)![0];
    expect(acct.body).toEqual({
      name: "Endeavour Group - DM",
      timezone: "Australia/Sydney",
      currency: "AUD",
      brand: { officialWebsite: "https://www.danmurphys.com.au/dm/home" },
    });
    expect(r).toMatchObject({
      workspace: rs.state.workspaces[0].id,
      account: acct.id,
    });
    expect(r.added).toEqual(["analyst@example.test"]);
  });
  it("reuses the same workspace and account for the next person and the next sign-in", async () => {
    const r = await prepareResponsys(
      db,
      cfg,
      { userId: "y", email: "analyst@example.test", workspaceId: company },
      "rci_session=b",
      rs.as("analyst@example.test"),
    );
    const again = await prepareResponsys(
      db,
      cfg,
      { userId: "x", email: "lead@example.test", workspaceId: company },
      "rci_session=c",
      rs.as("lead@example.test"),
    );
    expect(rs.state.workspaces).toHaveLength(1);
    expect(rs.state.accounts.get(rs.state.workspaces[0].id)).toHaveLength(1);
    expect(r.account).toBe(again.account);
    expect(
      rs.state.calls.filter(
        (c) => c.startsWith("analyst") && c.includes("POST /workspaces"),
      ),
    ).toEqual([]);
  });
  it("never creates a second workspace for someone not yet added", async () => {
    const other = fakeResponsys();
    const r = await prepareResponsys(
      db,
      cfg,
      { userId: "z", email: "new@example.test", workspaceId: company },
      "rci_session=d",
      other.as("new@example.test"),
    );
    expect(other.state.workspaces).toHaveLength(0);
    expect(r.note).toMatch(/administrator/);
  });
  it("lands on the account Summary, and only on Responsys's own pages", () => {
    const link = { account: "acc-1", added: [] };
    expect(landingFor("/", link)).toBe("/?account=acc-1&tab=briefing");
    expect(landingFor("/?signinError=failed", link)).toBe(
      "/?signinError=failed",
    );
    expect(landingFor("https://evil.example/", link)).toBe(
      "https://evil.example/",
    );
    expect(landingFor("//evil.example/", link)).toBe("//evil.example/");
    expect(landingFor("/", { added: [] })).toBe("/");
  });
  it("reads the Responsys session from the sign-in response", () => {
    expect(
      cookieHeader(["rci_session=abc; Path=/; HttpOnly", "x=1; Path=/"]),
    ).toBe("rci_session=abc; x=1");
    expect(cookieHeader(undefined)).toBe("");
  });
});
