import { describe, it, expect } from "vitest";
import { aggregate } from "../src/store/aggregate.ts";
import type { QaSessionRow } from "../src/store/rows.ts";
import { openDb } from "../src/store/schema.ts";
import { upsertSessions } from "../src/store/upsert.ts";

// 2026-07-06 12:00 北京 = 2026-07-06 04:00 UTC = 1783310400000
const D6 = Date.UTC(2026, 6, 6, 4, 0, 0);
const D1 = Date.UTC(2026, 6, 1, 4, 0, 0);
const mk = (o: Partial<QaSessionRow>): QaSessionRow => ({
  session_key: "k",
  session_id: null,
  user_id: "ou_1",
  user_name: "张三",
  channel: "feishu",
  chat_type: "direct",
  group_id: null,
  model: "m",
  provider: "p",
  input_tokens: 5,
  output_tokens: 5,
  total_tokens: 10,
  cache_read: 0,
  cache_write: 0,
  cost_usd: 0.2,
  message_count: 3,
  user_msgs: 1,
  assistant_msgs: 2,
  tool_calls: 0,
  error_count: 0,
  avg_latency_ms: 100,
  p95_latency_ms: 200,
  started_at: D6,
  last_interaction_at: D6,
  updated_at: D6,
  ...o,
});

describe("aggregate", () => {
  it("computes totals, active users, DAU/WAU, topUsers, byChatType", () => {
    const db = openDb(":memory:");
    upsertSessions(db, [
      mk({
        session_key: "a",
        user_id: "ou_1",
        last_interaction_at: D6,
        total_tokens: 10,
        message_count: 3,
      }),
      mk({
        session_key: "b",
        user_id: "ou_2",
        last_interaction_at: D6,
        total_tokens: 20,
        message_count: 5,
        chat_type: "group",
      }),
      mk({
        session_key: "c",
        user_id: "ou_1",
        last_interaction_at: D1,
        total_tokens: 7,
        message_count: 2,
      }),
    ]);
    const d = aggregate(db, { from: D1 - 1, to: D6 + 1 });
    expect(d.totalSessions).toBe(3);
    expect(d.totalMessages).toBe(10);
    expect(d.totalTokens).toBe(37);
    expect(d.activeUsers).toBe(2); // ou_1, ou_2 in window
    expect(d.dau).toBe(2); // last day 07-06: ou_1, ou_2
    expect(d.wau).toBe(2); // within 7 days
    expect(d.topUsers[0].user_id).toBe("ou_1"); // 2 sessions
    expect(d.byChatType.find((x) => x.chat_type === "group")!.sessions).toBe(1);
    expect(d.daily.length).toBeGreaterThanOrEqual(2);
  });
});
