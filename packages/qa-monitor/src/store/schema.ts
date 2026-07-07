// landingAgent-specific (not upstream openclaw)
import { DatabaseSync } from "node:sqlite";

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS qa_sessions (
      session_key TEXT PRIMARY KEY,
      session_id TEXT, user_id TEXT, user_name TEXT,
      channel TEXT, chat_type TEXT, group_id TEXT,
      model TEXT, provider TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read INTEGER NOT NULL DEFAULT 0,
      cache_write INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      message_count INTEGER NOT NULL DEFAULT 0,
      user_msgs INTEGER NOT NULL DEFAULT 0,
      assistant_msgs INTEGER NOT NULL DEFAULT 0,
      tool_calls INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      avg_latency_ms REAL, p95_latency_ms REAL,
      started_at INTEGER, last_interaction_at INTEGER, updated_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_qa_sessions_last ON qa_sessions(last_interaction_at);
    CREATE INDEX IF NOT EXISTS idx_qa_sessions_user ON qa_sessions(user_id);
    CREATE TABLE IF NOT EXISTS qa_admin_sessions (
      sid TEXT PRIMARY KEY, open_id TEXT NOT NULL, name TEXT,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
  `);
  return db;
}
