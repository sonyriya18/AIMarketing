import { createServer } from "vite";
import { config } from "./config";
import { Database } from "./db";
import { upgradeClientTemplates } from "./brand";
import { createApp } from "./app";
import { startWorker } from "./jobs";
import { responsysRuntime, startResponsys } from "./responsys-gateway";
const cfg = config(),
  db = new Database(cfg);
await db.query("SELECT 1");
await upgradeClientTemplates(db);
const app = createApp(db, cfg);
const vite = await createServer({
  server: { middlewareMode: true, hmr: { port: cfg.port + 10 } },
  appType: "spa",
});
app.use(vite.middlewares);
const server = app.listen(cfg.port, "127.0.0.1", () =>
  console.log(`Oracle AI Assessment Platform: ${cfg.origin}`),
);
const stop = startWorker(db, cfg);
if (cfg.responsysDir) {
  responsysRuntime.current = startResponsys(cfg);
  console.log(
    `Responsys (same sign-in): ${cfg.responsysUrl} — open it from a subscribed company's home page`,
  );
} else if (process.env.RESPONSYS_DIR !== "off")
  console.warn(
    '[responsys] Responsys was not found: it belongs in the "responsys" folder inside this platform folder (or set RESPONSYS_DIR in .env).',
  );
process.on("SIGINT", () => {
  responsysRuntime.current?.stop();
  stop();
  server.close();
  void vite.close();
  void db.close();
});
