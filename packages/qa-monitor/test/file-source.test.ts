import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// landingAgent-specific (not upstream openclaw)
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { parseTranscript, readSessionsFromDir } from "../src/collector/file-source.ts";

describe("parseTranscript", () => {
  it("sums usage, counts messages by role, computes latency", () => {
    const jsonl = [
      JSON.stringify({ type: "meta" }),
      JSON.stringify({ type: "message", message: { role: "user" } }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          durationMs: 100,
          usage: {
            input: 10,
            output: 5,
            cacheRead: 1,
            cacheWrite: 0,
            totalTokens: 15,
            cost: { total: 0.2 },
          },
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          durationMs: 300,
          usage: { input: 4, output: 6, totalTokens: 10, cost: { total: 0.1 } },
        },
      }),
    ].join("\n");
    const s = parseTranscript(jsonl);
    expect(s.messages).toBe(3); // user + 2 assistant (meta line has no message)
    expect(s.userMsgs).toBe(1);
    expect(s.assistantMsgs).toBe(2);
    expect(s.input).toBe(14);
    expect(s.output).toBe(11);
    expect(s.total).toBe(25);
    expect(s.cacheRead).toBe(1);
    expect(s.cost).toBeCloseTo(0.3, 5);
    expect(s.avgLatencyMs).toBe(200);
    expect(s.p95LatencyMs).toBe(300);
  });

  it("empty transcript → zeros and null latency", () => {
    const s = parseTranscript("");
    expect(s.messages).toBe(0);
    expect(s.total).toBe(0);
    expect(s.avgLatencyMs).toBeNull();
  });
});

describe("readSessionsFromDir", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "qa-fs-"));
    const sessDir = join(dir, "main", "sessions");
    mkdirSync(sessDir, { recursive: true });
    writeFileSync(
      join(sessDir, "sessions.json"),
      JSON.stringify({
        "agent:main:abc": {
          sessionId: "sid-1",
          chatType: "direct",
          model: "anthropic/claude-opus-4.7",
          modelProvider: "zenmux",
          lastChannel: "feishu",
          startedAt: 1000,
          lastInteractionAt: 2000,
          updatedAt: 2000,
          status: "idle",
          origin: { from: "feishu:ou_1", label: "ou_1", surface: "feishu", chatType: "direct" },
        },
      }),
    );
    writeFileSync(
      join(sessDir, "sid-1.jsonl"),
      [
        JSON.stringify({ type: "message", message: { role: "user" } }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            durationMs: 50,
            usage: { input: 3, output: 2, totalTokens: 5, cost: { total: 0.05 } },
          },
        }),
      ].join("\n"),
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("maps a session entry + its transcript into a QaSessionRow", () => {
    const rows = readSessionsFromDir(dir);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.session_key).toBe("agent:main:abc");
    expect(r.session_id).toBe("sid-1");
    expect(r.user_id).toBe("feishu:ou_1");
    expect(r.channel).toBe("feishu");
    expect(r.chat_type).toBe("direct");
    expect(r.model).toBe("anthropic/claude-opus-4.7");
    expect(r.provider).toBe("zenmux");
    expect(r.total_tokens).toBe(5);
    expect(r.message_count).toBe(2);
    expect(r.assistant_msgs).toBe(1);
    expect(r.avg_latency_ms).toBe(50);
    expect(r.last_interaction_at).toBe(2000);
  });

  it("missing dir → empty", () => {
    expect(readSessionsFromDir("/no/such/dir")).toEqual([]);
  });
});
