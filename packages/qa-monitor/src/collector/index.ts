// landingAgent-specific (not upstream openclaw)
import type { DatabaseSync } from "node:sqlite";
import type { SessionsUsageResult } from "../../../../src/shared/usage-types.ts";
import type { QaConfig } from "../config.ts";
import { upsertSessions } from "../store/upsert.ts";
import { mapUsageResultToRows } from "./map.ts";
import { fetchUsageViaGateway } from "./source.ts";

export type UsageFetcher = (cfg: QaConfig) => Promise<SessionsUsageResult>;

export async function collectOnce(
  db: DatabaseSync,
  cfg: QaConfig,
  fetch: UsageFetcher = fetchUsageViaGateway,
): Promise<number> {
  const result = await fetch(cfg);
  const rows = mapUsageResultToRows(result);
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
