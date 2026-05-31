import { describe, expect, it } from "vitest";
import { getSessionEntry, upsertSessionEntry } from "../../config/sessions/store.js";
import { useTempSessionsFixture } from "../../config/sessions/test-helpers.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createCreateGoalTool, createGetGoalTool } from "./goal-tools.js";

const config = {} as OpenClawConfig;

describe("goal tools", () => {
  useTempSessionsFixture("openclaw-goal-tools-");

  it("keeps get_goal read-only when accounting changes are projected", async () => {
    await upsertSessionEntry({
      agentId: "research",
      sessionKey: "global",
      entry: {
        sessionId: "sess-global",
        updatedAt: 1,
        totalTokens: 125,
        totalTokensFresh: true,
        goal: {
          schemaVersion: 1,
          id: "goal-1",
          objective: "ship",
          status: "active",
          createdAt: 1,
          updatedAt: 1,
          tokenStart: 100,
          tokenStartFresh: true,
          tokensUsed: 0,
          tokenBudget: 20,
          continuationTurns: 0,
        },
      },
    });
    const tool = createGetGoalTool({
      agentSessionKey: "global",
      runSessionKey: "global",
      sessionAgentId: "research",
      config,
    });

    const result = await tool.execute("call-1", {});

    expect((result.details as { goal?: { status?: string } }).goal?.status).toBe("budget_limited");
    expect(getSessionEntry({ agentId: "research", sessionKey: "global" })?.goal?.status).toBe(
      "active",
    );
  });

  it("uses the resolved session agent for global session stores", async () => {
    const tool = createCreateGoalTool({
      agentSessionKey: "global",
      runSessionKey: "global",
      sessionAgentId: "research",
      config,
    });

    await upsertSessionEntry({
      agentId: "research",
      sessionKey: "global",
      entry: { sessionId: "sess-global", updatedAt: 1 },
    });
    await tool.execute("call-1", { objective: "ship global work" });

    expect(getSessionEntry({ agentId: "research", sessionKey: "global" })?.goal?.objective).toBe(
      "ship global work",
    );
    expect(getSessionEntry({ agentId: "main", sessionKey: "global" })?.goal).toBeUndefined();
  });

  it("prefers scoped run session keys over the fallback session agent", async () => {
    const tool = createCreateGoalTool({
      agentSessionKey: "global",
      runSessionKey: "agent:ops:main",
      sessionAgentId: "research",
      config,
    });

    await upsertSessionEntry({
      agentId: "ops",
      sessionKey: "agent:ops:main",
      entry: { sessionId: "sess-ops", updatedAt: 1 },
    });
    await tool.execute("call-1", { objective: "ship ops work" });

    expect(getSessionEntry({ agentId: "ops", sessionKey: "agent:ops:main" })?.goal?.objective).toBe(
      "ship ops work",
    );
    expect(
      getSessionEntry({ agentId: "research", sessionKey: "agent:ops:main" })?.goal,
    ).toBeUndefined();
  });
});
