// landingAgent-specific (not upstream openclaw)
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export function createSession(
  db: DatabaseSync,
  openId: string,
  name: string | null,
  now: number,
  ttlMs: number,
): string {
  const sid = randomBytes(24).toString("hex");
  db.prepare(
    "INSERT INTO qa_admin_sessions (sid, open_id, name, created_at, expires_at) VALUES (?,?,?,?,?)",
  ).run(sid, openId, name, now, now + ttlMs);
  return sid;
}

export function getSession(
  db: DatabaseSync,
  sid: string | undefined,
  now: number,
): { open_id: string; name: string | null } | null {
  if (!sid) return null;
  const row = db
    .prepare("SELECT open_id, name, expires_at FROM qa_admin_sessions WHERE sid=?")
    .get(sid) as any;
  if (!row || row.expires_at <= now) return null;
  return { open_id: row.open_id, name: row.name ?? null };
}
