import express from "express";
import { resolve } from "node:path";
import { config } from "./config";
import { Database } from "./db";
import { createApp } from "./app";
import { startWorker } from "./jobs";
const cfg = config(),
  db = new Database(cfg);
await db.query("SELECT 1");
await db.assertProductionRole();
const app = createApp(db, cfg);
app.use(express.static(resolve("dist"), { index: false }));
app.get("*", (_req, res) => res.sendFile(resolve("dist/index.html")));
const server = app.listen(cfg.port, "0.0.0.0", () =>
  console.log(`Enterprise AI listening on ${cfg.port}`),
);
const stop = cfg.worker ? startWorker(db, cfg) : () => {};
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    stop();
    server.close(() => void db.close());
  });
