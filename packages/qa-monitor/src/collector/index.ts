// landingAgent-specific (not upstream openclaw)
import type { DatabaseSync } from "node:sqlite";
import type { QaConfig } from "../config.ts";
import type { QaSessionRow } from "../store/rows.ts";
import { upsertSessions } from "../store/upsert.ts";
import { readSessionsFromDir } from "./file-source.ts";

export type RowsReader = (cfg: QaConfig) => QaSessionRow[];

const defaultReader: RowsReader = (cfg) => readSessionsFromDir(cfg.agentsDir);

export function collectOnce(
  db: DatabaseSync,
  cfg: QaConfig,
  read: RowsReader = defaultReader,
): number {
  const rows = read(cfg);
  return upsertSessions(db, rows);
}

export function startCollector(db: DatabaseSync, cfg: QaConfig): () => void {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      await collectOnce(db, cfg);
    } catch (e) {
      console.error("[qa-monitor] collect failed:", e);
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), cfg.pollIntervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
