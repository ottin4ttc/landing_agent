import { startCollector } from "./collector/index.ts";
// landingAgent-specific (not upstream openclaw)
import { loadConfig } from "./config.ts";
import { openDb } from "./store/schema.ts";
import { createServer } from "./web/server.ts";

const cfg = loadConfig(process.env);
const db = openDb(cfg.dbPath);
const stop = startCollector(db, cfg);
const server = createServer(db, cfg);
server.listen(cfg.port, () =>
  console.log(`[qa-monitor] listening on http://127.0.0.1:${cfg.port}/qa-admin/dashboard`),
);
process.on("SIGINT", () => {
  stop();
  server.close();
  db.close();
  process.exit(0);
});
