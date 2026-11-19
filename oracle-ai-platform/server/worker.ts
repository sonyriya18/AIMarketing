import { config } from "./config";
import { Database } from "./db";
import { startWorker } from "./jobs";
const cfg = config(),
  db = new Database(cfg);
await db.query("SELECT 1");
await db.assertProductionRole();
const stop = startWorker(db, cfg);
console.log("Enterprise AI background worker started");
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    stop();
    void db.close();
  });
