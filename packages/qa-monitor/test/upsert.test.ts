import { describe, it, expect } from "vitest";
import type { QaSessionRow } from "../src/store/rows.ts";
import { openDb } from "../src/store/schema.ts";
import { upsertSessions } from "../src/store/upsert.ts";

const row = (over: Partial<QaSessionRow>): QaSessionRow => ({
  session_key: "k1",
  session_id: "s1",
  user_id: "ou_1",
  user_name: "张三",
  channel: "feishu",
  chat_type: "direct",
  group_id: null,
  model: "m",
  provider: "p",
  input_tokens: 10,
  output_tokens: 20,
  total_tokens: 30,
  cache_read: 0,
  cache_write: 0,
  cost_usd: 0.1,
  message_count: 4,
  user_msgs: 2,
  assistant_msgs: 2,
  tool_calls: 0,
  error_count: 0,
  avg_latency_ms: 100,
  p95_latency_ms: 150,
  started_at: 1000,
  last_interaction_at: 2000,
  updated_at: 2000,
  ...over,
});

describe("upsertSessions", () => {
  it("inserts then overwrites same session_key (idempotent, no double count)", () => {
    const db = openDb(":memory:");
    upsertSessions(db, [row({})]);
    upsertSessions(db, [row({ total_tokens: 55, message_count: 9 })]);
    const all = db.prepare("SELECT * FROM qa_sessions").all() as any[];
    expect(all).toHaveLength(1);
    expect(all[0].total_tokens).toBe(55);
    expect(all[0].message_count).toBe(9);
  });
});
