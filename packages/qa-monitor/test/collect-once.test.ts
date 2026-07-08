// landingAgent-specific (not upstream openclaw)
import { describe, it, expect } from "vitest";
import { collectOnce } from "../src/collector/index.ts";
import type { QaSessionRow } from "../src/store/rows.ts";
import { openDb } from "../src/store/schema.ts";

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
  input_tokens: 1,
  output_tokens: 2,
  total_tokens: 3,
  cache_read: 0,
  cache_write: 0,
  cost_usd: 0.1,
  message_count: 2,
  user_msgs: 1,
  assistant_msgs: 1,
  tool_calls: 0,
  error_count: 0,
  avg_latency_ms: 10,
  p95_latency_ms: 10,
  started_at: 1000,
  last_interaction_at: 2000,
  updated_at: 2000,
  ...over,
});

describe("collectOnce", () => {
  it("reads rows and upserts; idempotent across two runs", () => {
    const db = openDb(":memory:");
    const cfg: any = { agentsDir: "/unused" };
    const read = () => [row({})];
    const n1 = collectOnce(db, cfg, read);
    const n2 = collectOnce(db, cfg, read);
    expect(n1).toBe(1);
    expect(n2).toBe(1);
    const rows = db.prepare("SELECT COUNT(*) c FROM qa_sessions").get() as any;
    expect(rows.c).toBe(1); // same session_key not double-counted
  });
});
