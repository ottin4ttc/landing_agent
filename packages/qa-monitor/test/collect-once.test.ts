// landingAgent-specific (not upstream openclaw)
import { describe, it, expect } from "vitest";
import { collectOnce } from "../src/collector/index.ts";
import { openDb } from "../src/store/schema.ts";

const fakeResult: any = {
  updatedAt: 1,
  startDate: "2026-07-01",
  endDate: "2026-07-06",
  sessions: [
    {
      key: "k1",
      origin: { from: "ou_1", label: "张三" },
      chatType: "direct",
      usage: {
        input: 1,
        output: 2,
        totalTokens: 3,
        cacheRead: 0,
        cacheWrite: 0,
        totalCost: 0.1,
        messageCounts: { total: 2, user: 1, assistant: 1, toolCalls: 0, toolResults: 0, errors: 0 },
        latency: { count: 1, avgMs: 10, p95Ms: 10, minMs: 10, maxMs: 10 },
        lastActivity: 2000,
      },
      updatedAt: 2000,
    },
  ],
  totals: {},
  aggregates: {},
};

describe("collectOnce", () => {
  it("fetches, maps and upserts; idempotent across two runs", async () => {
    const db = openDb(":memory:");
    const cfg: any = { usageRangeDays: 30 };
    const n1 = await collectOnce(db, cfg, async () => fakeResult);
    const n2 = await collectOnce(db, cfg, async () => fakeResult);
    expect(n1).toBe(1);
    expect(n2).toBe(1);
    const rows = db.prepare("SELECT COUNT(*) c FROM qa_sessions").get() as any;
    expect(rows.c).toBe(1); // same session_key not double-counted
  });
});
