// One port for all four tools (local development). The platform starts the unmodified Responsys
// v17 app from its own folder on an internal port and serves it at http://responsys.<host>:<port>.
// v17 receives its sign-in settings as environment variables (single sign-on through /sso), so no
// v17 file is changed and its own .env.local keeps supplying the database and AI settings.
import http from "node:http";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type express from "express";
import dotenv from "dotenv";
import pg from "pg";
import type { Config } from "./config";
import { LOCAL_SUBJECT_PREFIX, SSO_CLIENT_ID, issuerOf } from "./sso";

// Operating-system variables v17 may need. Platform database and session secrets are never
// passed: v17 reads its own from its .env.local. The only shared setting is the AI key (Gemini or
// ChatGPT: one key for all four tools), unless RESPONSYS_SHARE_AI=false.
// Network settings for office networks (company proxy, Windows certificates) are passed too, so
// v17 reaches the AI service the same way the platform does.
const OS_KEYS =
  /^(path|pathext|systemroot|windir|comspec|home|homedrive|homepath|userprofile|appdata|localappdata|programdata|programfiles(\(x86\))?|temp|tmp|tmpdir|lang|lc_all|os|processor_architecture|number_of_processors|computername|username|user|shell|xdg_runtime_dir|https?_proxy|no_proxy|node_use_env_proxy|node_options|node_use_system_ca|node_extra_ca_certs)$/i;

export function responsysEnv(cfg: Config, base: NodeJS.ProcessEnv) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base))
    if (v !== undefined && OS_KEYS.test(k)) env[k] = v;
  // With a company proxy, v17's own requests use it too, except its sign-in calls to this platform.
  const proxy = env.HTTPS_PROXY || env.https_proxy;
  const local = "localhost,127.0.0.1,::1,.localhost";
  const proxyEnv: Record<string, string> = proxy
    ? {
        NODE_USE_ENV_PROXY: "1",
        NO_PROXY: [env.NO_PROXY || env.no_proxy, local]
          .filter(Boolean)
          .join(","),
      }
    : {};
  return {
    ...env,
    ...proxyEnv,
    NODE_ENV: "development",
    PORT: String(cfg.responsysInternalPort),
    APP_BASE_URL: cfg.responsysUrl,
    AUTH_MODE: "oidc",
    OIDC_ISSUER_URL: cfg.origin + "/sso",
    OIDC_CLIENT_ID: SSO_CLIENT_ID,
    OIDC_CLIENT_SECRET: cfg.ssoSecret,
    // The platform serves v17 through this gateway; hot-reload sockets are not proxied.
    DISABLE_HMR: "true",
    // One AI key for all four tools: v17 gets the same Gemini or ChatGPT (OpenAI) settings.
    ...(cfg.shareAiWithResponsys && cfg.aiKey && cfg.aiProvider === "gemini"
      ? {
          AI_PROVIDER: "gemini",
          AI_MODEL: cfg.aiModel,
          GEMINI_API_KEY: cfg.aiKey,
        }
      : cfg.shareAiWithResponsys &&
          cfg.aiKey &&
          cfg.aiProvider === "openai-compatible"
        ? {
            AI_PROVIDER: "openai",
            AI_MODEL: cfg.aiModel,
            // The current Responsys release reads its ChatGPT model from OPENAI_MODEL.
            OPENAI_MODEL: cfg.aiModel,
            OPENAI_API_KEY: cfg.aiKey,
            OPENAI_BASE_URL: cfg.aiBase,
          }
        : {}),
  };
}

/** The v17 process started by this server, if any (read by the gateway and the provider check). */
export const responsysRuntime: { current: ResponsysProcess | null } = {
  current: null,
};
export interface ResponsysProcess {
  state: "starting" | "running" | "stopped" | "missing";
  message: string;
  stop: () => void;
}

/** Why v17 cannot start yet, in plain words (null when its folder is set up). */
export function responsysSetupProblem(dir: string): string | null {
  if (!existsSync(join(dir, "server", "dev.ts")))
    return `Responsys v17 was not found in ${dir}. It belongs in the \"responsys\" folder inside the platform folder. Then double-click 1-SETUP.cmd.`;
  if (!existsSync(join(dir, "node_modules", "tsx", "dist", "cli.mjs")))
    return "Responsys is not installed yet (responsys\\node_modules is missing). Extract every part of the download into the same folder, then double-click 1-SETUP.cmd.";
  const envFile = join(dir, ".env.local");
  const settings = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
  if (!/^DATABASE_URL=postgres/m.test(settings))
    return "Responsys has no database settings yet (responsys\\.env.local). Double-click 1-SETUP.cmd (it creates the Responsys database), then 2-START.cmd.";
  return null;
}

/**
 * How the supplied Responsys release is started. The Windows bundle carries its own PostgreSQL
 * (runtime\\pgsql, data in .local\\postgres-data) and serves its prebuilt screens from dist with
 * server/index.ts, exactly as its own Start.ps1 does. Source checkouts fall back to server/dev.ts.
 */
export function responsysLayout(dir: string) {
  const exe = process.platform === "win32" ? ".exe" : "";
  const pgCtl = join(dir, "runtime", "pgsql", "bin", "pg_ctl" + exe);
  const pgData = join(dir, ".local", "postgres-data");
  const prebuilt =
    existsSync(join(dir, "dist", "index.html")) &&
    existsSync(join(dir, "server", "index.ts"));
  return {
    portableDatabase: existsSync(pgCtl) && existsSync(join(pgData, "PG_VERSION")),
    pgCtl,
    pgData,
    pgLog: join(dir, ".local", "postgres.log"),
    args: prebuilt
      ? ["--use-system-ca", "--import", "tsx", "server/index.ts"]
      : [join(dir, "node_modules", "tsx", "dist", "cli.mjs"), "server/dev.ts"],
  };
}

/** Starts the bundled Responsys PostgreSQL when it is not running (same as its Start.ps1). */
export function ensureResponsysDatabase(dir: string): string | null {
  const l = responsysLayout(dir);
  if (!l.portableDatabase) return null;
  const status = spawnSync(l.pgCtl, ["-D", l.pgData, "status"], { windowsHide: true });
  if (status.status === 0) return null;
  const start = spawnSync(l.pgCtl, ["-D", l.pgData, "-l", l.pgLog, "-w", "start"], { windowsHide: true, timeout: 60_000 });
  return start.status === 0 ? null : "The Responsys database could not start. Look at responsys\\.local\\postgres.log, or double-click 1-SETUP.cmd again.";
}

/**
 * Local development only. Sign-in links that v17 stored for an earlier local platform install
 * (older, random subjects from this same local issuer) are cleared, so the same email links again
 * at the next sign-in. Users, workspaces and data in v17 are not changed.
 */
export async function relinkLocalResponsysUsers(cfg: Config): Promise<number> {
  if (cfg.production) return 0;
  const settings = dotenv.parse(
    readFileSync(join(cfg.responsysDir, ".env.local")),
  );
  if (!settings.DATABASE_URL) return 0;
  const client = new pg.Client({
    connectionString: settings.DATABASE_URL,
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  try {
    const r = await client.query(
      "UPDATE users SET oidc_issuer = NULL, oidc_subject = NULL WHERE oidc_issuer = $1 AND oidc_subject NOT LIKE $2",
      [issuerOf(cfg), LOCAL_SUBJECT_PREFIX + "%"],
    );
    return r.rowCount ?? 0;
  } finally {
    await client.end().catch(() => {});
  }
}

/** Turns v17's last start-up output into one clear next step. */
export function explainResponsysExit(output: string, port: number): string {
  if (/password authentication failed/i.test(output))
    return "Responsys v17 could not sign in to PostgreSQL (wrong database password). Double-click 1-SETUP.cmd again, then 2-START.cmd.";
  if (/ECONNREFUSED[^\n]*5432|connect ECONNREFUSED/i.test(output))
    return 'PostgreSQL is not running, so Responsys v17 cannot start. Start it (Windows: press Win+R, type services.msc, find "postgresql", click Start), then double-click 2-START.cmd again.';
  if (/database "[^"]+" does not exist/i.test(output))
    return "The Responsys database does not exist yet. Double-click 1-SETUP.cmd, then 2-START.cmd.";
  if (/EADDRINUSE/i.test(output))
    return `Port ${port} is already in use by another program. Close the other app windows and double-click 2-START.cmd again.`;
  const last = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  return `Responsys v17 stopped${last ? `: ${last.slice(0, 300)}` : ""}. See the [responsys] lines in the 2-START window.`;
}

/** Starts v17 (`tsx server/dev.ts` in its folder) and restarts it once if it exits early. */
export function startResponsys(cfg: Config): ResponsysProcess {
  const dir = cfg.responsysDir;
  const tsx = join(dir, "node_modules", "tsx", "dist", "cli.mjs");
  const status: ResponsysProcess = {
    state: "starting",
    message: "Responsys v17 is starting",
    stop: () => {},
  };
  const problem = responsysSetupProblem(dir);
  if (problem) {
    status.state = "missing";
    status.message = problem;
    console.warn("[responsys] " + status.message);
    return status;
  }
  relinkLocalResponsysUsers(cfg)
    .then((n) => {
      if (n)
        console.log(
          `[responsys] Reconnected ${n} Responsys sign-in(s) from an earlier platform install.`,
        );
    })
    .catch((e) =>
      console.warn(
        "[responsys] Could not check Responsys sign-ins: " +
          (e as Error).message,
      ),
    );
  let child: ChildProcess | null = null,
    stopping = false,
    restarts = 0;
  const layout = responsysLayout(dir);
  const dbProblem = ensureResponsysDatabase(dir);
  if (dbProblem) console.warn("[responsys] " + dbProblem);
  void tsx;
  const run = () => {
    child = spawn(process.execPath, layout.args, {
      cwd: dir,
      env: responsysEnv(cfg, process.env),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let recent = "";
    const log = (b: Buffer) => {
      const text = b.toString();
      recent = (recent + text).slice(-4000);
      text
        .split(/\r?\n/)
        .filter(Boolean)
        .forEach((l) => console.log("[responsys] " + l));
    };
    child.stdout!.on("data", log);
    child.stderr!.on("data", log);
    child.on("exit", (code) => {
      status.state = "stopped";
      status.message = explainResponsysExit(
        recent || `exit code ${code}`,
        cfg.responsysInternalPort,
      );
      console.warn("[responsys] " + status.message);
      if (!stopping && restarts < 1) {
        restarts++;
        setTimeout(run, 3000);
      }
    });
  };
  // A Responsys left running by an earlier start (e.g. the window was closed abruptly) is reused
  // instead of failing with "port already in use".
  const probe = http.get(
    { host: "127.0.0.1", port: cfg.responsysInternalPort, path: "/api/health/ready", timeout: 1500 },
    (res) => {
      res.resume();
      if (res.statusCode === 200) {
        status.state = "running";
        status.message = "Responsys is running (reused the copy that was already started)";
        console.log("[responsys] " + status.message);
      } else run();
    },
  );
  probe.on("error", () => run());
  probe.on("timeout", () => probe.destroy());
  const poll = setInterval(() => {
    const r = http.get(
      {
        host: "127.0.0.1",
        port: cfg.responsysInternalPort,
        path: "/api/v1/auth/config",
        timeout: 2000,
      },
      (res) => {
        res.resume();
        if (res.statusCode === 200) {
          status.state = "running";
          status.message = "Responsys v17 is running";
        }
      },
    );
    r.on("error", () => {});
    r.on("timeout", () => r.destroy());
  }, 3000);
  status.stop = () => {
    stopping = true;
    clearInterval(poll);
    child?.kill();
  };
  console.log(`[responsys] Starting Responsys v17 from ${dir}`);
  return status;
}

const unavailable = (res: express.Response, status: ResponsysProcess | null) =>
  res
    .status(502)
    .type("html")
    .send(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Responsys is starting</title><body style="font-family:system-ui;max-width:640px;margin:10vh auto;padding:0 16px;line-height:1.5"><h1>Responsys v17 is not answering yet</h1><p>${(status?.message || "Responsys v17 is starting").replace(/[<>&]/g, "")}. Refresh in a few seconds.</p></body>`,
    );

/**
 * v17 forbids being shown inside another page. Behind this gateway it may be shown inside the
 * platform window, and only there: the frame rule names the platform origin. Nothing else in the
 * response changes.
 */
export function framable(
  headers: http.IncomingHttpHeaders,
  platformOrigin: string,
): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = { ...headers };
  delete out["x-frame-options"];
  const csp = out["content-security-policy"];
  if (typeof csp === "string") {
    const kept = csp
      .split(";")
      .map((d) => d.trim())
      .filter((d) => d && !/^frame-ancestors\b/i.test(d));
    out["content-security-policy"] = [
      ...kept,
      `frame-ancestors ${platformOrigin}`,
    ].join("; ");
  } else out["content-security-policy"] = `frame-ancestors ${platformOrigin}`;
  // To the browser, responsys.localhost and localhost are different sites, so v17's sign-in
  // cookie would be blocked inside the platform window. It is marked for use inside a frame,
  // kept separate per top-level site (Partitioned). v17 still checks its own CSRF token.
  const cookies = out["set-cookie"];
  if (cookies)
    out["set-cookie"] = (
      Array.isArray(cookies) ? cookies : [String(cookies)]
    ).map((c) =>
      c
        .split(";")
        .map((p) => p.trim())
        .filter((p) => p && !/^(samesite|secure|partitioned)\b/i.test(p))
        .concat(["SameSite=None", "Secure", "Partitioned"])
        .join("; "),
    );
  return out;
}

/**
 * Forwards requests for responsys.<host>:<port> to v17 unchanged (method, path, headers, body and
 * streaming responses). Must run before any body parser.
 */
export function responsysGateway(
  cfg: Config,
  status: () => ResponsysProcess | null,
): express.RequestHandler {
  const host = cfg.responsysHost.toLowerCase();
  return (req, res, next) => {
    if ((req.headers.host || "").toLowerCase() !== host) return next();
    const up = http.request(
      {
        host: "127.0.0.1",
        port: cfg.responsysInternalPort,
        method: req.method,
        path: req.originalUrl,
        headers: req.headers,
      },
      (r) => {
        res.writeHead(r.statusCode || 502, framable(r.headers, cfg.origin));
        r.pipe(res);
      },
    );
    up.on("error", () => {
      if (!res.headersSent) unavailable(res, status());
      else res.end();
    });
    req.pipe(up);
    res.on("close", () => up.destroy());
  };
}
