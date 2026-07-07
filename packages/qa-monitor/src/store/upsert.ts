// landingAgent-specific (not upstream openclaw)
import type { DatabaseSync } from "node:sqlite";
import { QA_SESSION_COLUMNS, type QaSessionRow } from "./rows.ts";

export function upsertSessions(db: DatabaseSync, rows: QaSessionRow[]): number {
  if (rows.length === 0) return 0;
  const cols = QA_SESSION_COLUMNS;
  const placeholders = cols.map((c) => `@${c}`).join(", ");
  const updates = cols
    .filter((c) => c !== "session_key")
    .map((c) => `${c}=excluded.${c}`)
    .join(", ");
  const stmt = db.prepare(
    `INSERT INTO qa_sessions (${cols.join(", ")}) VALUES (${placeholders}) ` +
      `ON CONFLICT(session_key) DO UPDATE SET ${updates}`,
  );
  db.exec("BEGIN");
  try {
    for (const r of rows) stmt.run(r);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return rows.length;
}
