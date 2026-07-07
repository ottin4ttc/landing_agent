import { describe, it, expect } from "vitest";
import { mapUsageResultToRows } from "../src/collector/map.ts";

const result: any = {
  updatedAt: 5000,
  startDate: "2026-07-01",
  endDate: "2026-07-06",
  sessions: [
    {
      key: "k1",
      sessionId: "s1",
      agentId: "main",
      channel: "feishu",
      chatType: "direct",
      origin: { from: "ou_1", label: "张三", surface: "feishu", chatType: "direct" },
      model: "claude-opus-4.7",
      modelProvider: "zenmux",
      usage: {
        input: 10,
        output: 20,
        totalTokens: 30,
        cacheRead: 1,
        cacheWrite: 2,
        totalCost: 0.5,
        firstActivity: 1000,
        lastActivity: 2000,
        messageCounts: { total: 4, user: 2, assistant: 2, toolCalls: 0, toolResults: 0, errors: 0 },
        latency: { count: 2, avgMs: 100, p95Ms: 150, minMs: 50, maxMs: 200 },
      },
      updatedAt: 2000,
    },
    { key: "k2", usage: null, updatedAt: 3000 },
  ],
  totals: {},
  aggregates: {},
};

describe("mapUsageResultToRows", () => {
  it("maps fields and zero-fills null usage", () => {
    const rows = mapUsageResultToRows(result);
    expect(rows).toHaveLength(2);
    const a = rows[0];
    expect(a.session_key).toBe("k1");
    expect(a.user_id).toBe("ou_1");
    expect(a.user_name).toBe("张三");
    expect(a.total_tokens).toBe(30);
    expect(a.cost_usd).toBe(0.5);
    expect(a.message_count).toBe(4);
    expect(a.avg_latency_ms).toBe(100);
    expect(a.p95_latency_ms).toBe(150);
    expect(a.started_at).toBe(1000);
    expect(a.last_interaction_at).toBe(2000);
    const b = rows[1];
    expect(b.session_key).toBe("k2");
    expect(b.total_tokens).toBe(0);
    expect(b.cost_usd).toBe(0);
    expect(b.last_interaction_at).toBe(3000);
  });
});
