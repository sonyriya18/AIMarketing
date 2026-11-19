// Local Windows start (2-START.cmd): the same platform as server/dev.ts, but it serves the built
// screens in "dist" instead of compiling them, so no npm and no build step are needed on the PC.
// Responsys (the "responsys" folder) is started and served at responsys.localhost:<port>.
import express from "express";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config";
import { Database } from "./db";
import { createApp } from "./app";
import { startWorker } from "./jobs";
import { responsysRuntime, startResponsys } from "./responsys-gateway";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");
if (!existsSync(resolve(dist, "index.html"))) {
  console.error(
    'The built screens ("dist" folder) are missing. Extract the complete package again, or run "npm run build".',
  );
  process.exit(1);
}
const cfg = config(),
  db = new Database(cfg);
await db.query("SELECT 1");
const app = createApp(db, cfg);
app.use(express.static(dist, { index: false }));
app.get("*", (_req, res) => res.sendFile(resolve(dist, "index.html")));
const server = app.listen(cfg.port, "127.0.0.1", () =>
  console.log(
    `Oracle AI Platform (Responsys, Eloqua, Unity, Infinity): ${cfg.origin}`,
  ),
);
const stop = startWorker(db, cfg);
if (cfg.responsysDir) {
  responsysRuntime.current = startResponsys(cfg);
  console.log(`Responsys (same sign-in): ${cfg.responsysUrl}`);
} else if (process.env.RESPONSYS_DIR !== "off")
  console.warn(
    '[responsys] Responsys was not found in the "responsys" folder.',
  );
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    responsysRuntime.current?.stop();
    stop();
    server.close();
    void db.close().finally(() => process.exit(0));
  });
